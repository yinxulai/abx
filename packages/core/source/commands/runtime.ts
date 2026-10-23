/**
 * CLI 各个命令共用的东西：找配置、连 broker、算舱面地址。
 *
 * 「确保 broker 在跑」这一段值得单独说：`abx open` 有两种处境——
 * broker 已经被人起着了（那就接上去），或者没有（那就自己起一个子进程）。
 * 两种情况下**舱令牌的来源不一样**，而拿错令牌的表现是舱内所有请求都 401，
 * 报错还只说「令牌不对」，很难联想到「原来连的不是同一个 broker」。
 * 所以这里的逻辑写死成一句话：**要么从环境变量拿，要么从令牌文件拿，两者都没有就报错**，
 * 不做「猜一个」这种事。
 */

import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import {
  ConfigError,
  findConfigFile,
  loadConfig,
  type AbxConfig,
  type SandboxBackendId,
} from '@abx/contracts'
import {
  DEFAULT_CELL_ID,
  defaultCellTokenPath,
  formatHostForUrl,
  generateCellToken,
  readCellTokenFile,
  startBroker,
} from '../broker/index'

export interface CommandContext {
  readonly config: AbxConfig
  readonly configPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
}

export class CommandError extends Error {
  /** 给用户的下一步建议。不是每条错误都有明确的下一步。 */
  readonly hint: string | null

  constructor(message: string, hint: string | null = null) {
    super(message)
    this.name = 'CommandError'
    this.hint = hint
  }
}

export interface ResolveContextInput {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly configPath: string | null
}

export function resolveContext(input: ResolveContextInput): CommandContext {
  const found = findConfigFile({ cwd: input.cwd, explicitPath: input.configPath, env: input.env })
  if (!found.ok) {
    throw new CommandError(
      `找不到配置文件 abx.config.json。找过这些位置：\n${found.searched.map((path) => `  ${path}`).join('\n')}`,
      '用 --config <path> 指定，或设环境变量 ABX_CONFIG。',
    )
  }

  // 同步读：CLI 是短命进程，异步读只会让每个调用点多一层 await，换不来任何东西。
  // 配置文件也就几 KB。
  const result = loadConfig({
    filePath: found.path,
    env: input.env,
    readFile: (path) => readFileSync(path, 'utf8'),
  })

  if (!result.ok) {
    throw new CommandError(`配置文件有问题：${found.path}\n${new ConfigError(result.issues).message}`)
  }

  return {
    config: result.config,
    configPath: found.path,
    env: input.env,
    cwd: input.cwd,
  }
}

/**
 * 生效的后端。
 *
 * 命令行 > 配置。默认是 `docker`（见 `DEFAULT_CONFIG`）——「默认不安全」是这类工具
 * 最不该有的性质。
 */
export function resolveBackend(config: AbxConfig, override: SandboxBackendId | null): SandboxBackendId {
  return override ?? config.session.backend
}

/**
 * 舱面绑到哪儿。
 *
 * local 后端跑在宿主上，能连到它的地址就是回环——配置里默认的 `172.17.0.1`
 * 是 docker 网桥的网关，docker 没起来时那个地址压根不存在，bind 会直接失败。
 * 所以这里跟着后端走，而不是让用户自己去改配置。
 */
export function resolveCellHost(config: AbxConfig, backend: SandboxBackendId, override: string | null): string {
  if (override !== null) return override
  if (backend === 'local') return '127.0.0.1'
  return config.broker.cellHost
}

export function cellOriginFor(config: AbxConfig, cellHost: string): string {
  return `http://${formatHostForUrl(cellHost)}:${config.broker.cellPort}`
}

export function hostOriginFor(config: AbxConfig): string {
  return `http://${formatHostForUrl(config.broker.host)}:${config.broker.hostPort}`
}

/** 这个端口上有没有人在听。 */
export function isPortOpen(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

export async function waitForPort(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isPortOpen(host, port)) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 一个舱实际拿到的令牌与它绑定的身份。 */
export interface CellBinding {
  /** 令牌在注册表里绑定的舱 id。正常等于请求的 cellId。 */
  readonly cellId: string
  readonly token: string
  /**
   * 是不是注册表分配的专属令牌。
   *
   * `false` 表示接上了一个**别的进程**里的 broker：注册表不在我们手里，
   * 只能退回宿主固定令牌（默认舱）。这种情况下所有会话共享一个身份。
   */
  readonly dedicated: boolean
}

export interface BrokerLease {
  readonly hostOrigin: string
  readonly cellOrigin: string
  readonly cellToken: string
  /** 是我们起的，还是接上了一个已经在跑的。 */
  readonly spawned: boolean
  /** 起舱：登记一个舱并拿到它专属的令牌。 */
  registerCell(cellId: string): CellBinding
  /** 舱销毁：注销；返回是否真的删掉了一条。 */
  unregisterCell(cellId: string): boolean
  stop(): Promise<void>
}

export interface EnsureBrokerInput {
  readonly context: CommandContext
  readonly backend: SandboxBackendId
  readonly cellHost: string
  readonly log: (message: string) => void
}

/**
 * 确保有一个 broker 在跑，并拿到跟它匹配的舱令牌。
 *
 * 已经在跑（宿主面端口有人听）时**不**去动它：那个 broker 可能是用户自己
 * 前台起着的，杀了它会把别人的会话一起干掉。
 */
export async function ensureBroker(input: EnsureBrokerInput): Promise<BrokerLease> {
  const { config } = input.context
  const hostOrigin = hostOriginFor(config)
  const cellOrigin = cellOriginFor(config, input.cellHost)

  if (await isPortOpen(config.broker.host, config.broker.hostPort)) {
    const token = readLiveToken(input.context)
    input.log(`[abx] 接上已经在跑的 broker：${hostOrigin}`)
    return {
      hostOrigin,
      cellOrigin,
      cellToken: token,
      spawned: false,
      registerCell: (cellId) => {
        // 注册表在另一个进程里，没有跨进程接口。这里只能退回默认舱，
        // 说清楚是为了让人知道「这个会话的审计身份不是它自己的 id」。
        input.log(
          `[abx] 注意：接上的是已经在跑的 broker，无法为 ${cellId} 单独注册令牌；` +
            `本次会话使用默认舱 ${DEFAULT_CELL_ID} 的宿主固定令牌。`,
        )
        return { cellId: DEFAULT_CELL_ID, token, dedicated: false }
      },
      unregisterCell: () => false,
      stop: () => Promise.resolve(),
    }
  }

  // 自己起一个。令牌由我们生成、通过环境变量传给子进程，
  // 于是两边一定拿到同一个值，不需要事后去读文件对答案。
  const token = readLiveToken(input.context, { allowEphemeral: true })
  input.log(`[abx] 启动 broker：${hostOrigin}（舱面 ${cellOrigin}）`)

  // 同进程起，不拉子进程。
  //
  // 产品没有命令行，原先那个「拿自己的入口路径再 spawn 一个自己」的做法已经没有入口可指。
  // 更重要的理由是令牌：同进程里是直接传值，**不存在两边对不上**这种失败模式。
  const handle = await startBroker({
    config,
    env: input.context.env,
    cellToken: token,
    cellHost: input.cellHost,
    logger: { info: input.log, warn: input.log, error: input.log },
  })

  return {
    hostOrigin: handle.hostOrigin,
    cellOrigin: handle.cellOrigin,
    cellToken: handle.cellToken,
    spawned: true,
    registerCell: (cellId) => ({ cellId, token: handle.registerCell(cellId), dedicated: true }),
    unregisterCell: (cellId) => handle.unregisterCell(cellId),
    stop: () => handle.close(),
  }
}

/**
 * 拿舱令牌。
 *
 * 三条路，顺序固定：环境变量 → 令牌文件 → 临时生成（只有我们自己起 broker 时才允许）。
 * 允许临时生成的那一条必须显式打开，因为「以为连的是别人的 broker、其实令牌对不上」
 * 这种情况如果被静默兜住，表现出来就是舱内一堆 401。
 */
export interface ReadLiveTokenOptions {
  readonly allowEphemeral?: boolean
}

export function readLiveToken(context: CommandContext, options: ReadLiveTokenOptions = {}): string {
  const fromEnv = context.env[context.config.broker.cellTokenEnv]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()

  const tokenFile = defaultCellTokenPath(context.config.broker.auditPath)
  const fromFile = readCellTokenFile(tokenFile)
  if (fromFile !== null) return fromFile

  if (options.allowEphemeral === true) return generateCellToken()

  throw new CommandError(
    `拿不到舱令牌：环境变量 ${context.config.broker.cellTokenEnv} 没设置，${tokenFile} 也不存在。`,
    `设置 ${context.config.broker.cellTokenEnv}，或者先跑一次 \`abx broker\`（它会把令牌写到那个文件里）。`,
  )
}


