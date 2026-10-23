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
  bindHostCandidates,
  defaultCellTokenPath,
  formatHostForUrl,
  generateCellToken,
  readCellTokenFile,
  startBroker,
} from '../broker/index'
import type { HostPlatform } from '../host-platform'
import { createFileTransomLedger, defaultTransomLedgerPath } from '../transom/ledger'
import { createTransomMcpHandler, type TransomMcpHandler } from '../transom/mcp'
import { createSystemOpener, type Opener } from '../transom/opener'
import { defaultOutboxRoot } from '../transom/outbox'
import { createTransomService, type TransomSession } from '../transom/service'

export interface CommandContext {
  readonly config: AbxConfig
  readonly configPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /**
   * 宿主是什么系统。
   *
   * 命令层不自己去读 `process.platform`：那个值只在**宿主层**（`apps/app`、
   * 或者测试/e2e 驱动）读一次，再顺着这里往下传。理由见 `../host-platform.ts`——
   * 开发机是 Linux，「Windows 上的规则对不对」只能靠把平台当参数传进来才验得了。
   *
   * 类型是 `HostPlatform` 而不是 `NodeJS.Platform`：外面那个值可能是一台我们没有
   * 规则的系统（`freebsd`），那种情况下正确的做法是**在进入这里之前就拒绝**，
   * 而不是带着一个「认不出」的值走到闸门附近才发现。转换那一步是
   * `requireHostPlatform()`。
   */
  readonly platform: HostPlatform
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
  /**
   * 宿主是什么系统，由宿主层读 `process.platform` 之后经 `requireHostPlatform()`
   * 转成这个值。**必填且不设默认**：忘了传得到的不是「按 Linux 算」，而是编译不过。
   */
  readonly platform: HostPlatform
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
    platform: input.platform,
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
 * 舱面**告诉舱内**的那个地址。
 *
 * local 后端跑在宿主上，能连到它的地址就是回环。docker 后端上这个值是**候选**：
 * 真正该告诉舱内哪一个要由 `decideCellHost()` 从舱内探出来（见
 * `../broker/cell-host.ts`）——Docker Desktop 上只有 `host.docker.internal` 好使，
 * 原生 linux docker 上是网桥网关，`192.168.65.2` 是旧版 Docker Desktop 的 VM 网关。
 * 这里给的是「先按哪个来」，探测有了结论之后以结论为准。
 */
export function resolveCellHost(config: AbxConfig, backend: SandboxBackendId, override: string | null): string {
  if (override !== null) return override
  if (backend === 'local') return '127.0.0.1'
  return config.broker.cellHost
}

/**
 * 舱面按这个顺序试 bind，第一个成功的算数。
 *
 * 与 `resolveCellHost` 是**两个问题**：那个问「告诉舱内哪个地址」，这个问
 * 「宿主机上绑哪张网卡」。混起来是 Docker Desktop 上舱面起不来的原因——
 * 那里没有 `172.17.0.1` 这张网卡，而配置里的默认值恰恰是它。
 * 判定在纯函数那一侧（`bindHostCandidates()`），这里只负责把配置喂进去。
 */
export function resolveCellBindHosts(config: AbxConfig, backend: SandboxBackendId, override: string | null): readonly string[] {
  return bindHostCandidates({ backend, configuredHost: config.broker.cellHost, override })
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

/** 传递窗在这次运行里的位置。**不含任何凭据**——它只说明「东西会落到哪儿、账记在哪儿」，
 * 而这两件事是用户需要知道的（他要去看那些文件）。
 */
export interface TransomStatus {
  /** 交付根。每一次会话在它下面一格（见 `outboxDirFor`）。 */
  readonly outboxRoot: string
  readonly ledgerPath: string
  /** 打开文件用的是什么命令；`null` = 这台机器上不知道怎么打开。 */
  readonly openerName: string | null
}

/**
 * 会话结束时能拿到的那一份。
 *
 * `close()` 等的是账本的最后几条记录：交付那一步已经 `await` 过账，所以它兜的是
 * 「进程马上要退出了，别把还在队列里的那一行丢掉」。
 */
export interface TransomLease extends TransomStatus {
  close(): Promise<void>
}

/** 传递窗在宿主这一侧的运行时：处理器 + 位置。 */
export interface TransomRuntime extends TransomLease {
  readonly handler: TransomMcpHandler
}

export interface TransomRuntimeOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * 打开文件的实现。不给就按平台造一个（见 `createSystemOpener`）。
   *
   * **可注入是有意的**：它是唯一一处会在宿主上引起副作用的动作，用例里不能真的弹窗。
   */
  readonly opener?: Opener | null
}

/**
 * 把传递窗在宿主这一侧拼起来：交付根 + 账本 + 打开方式 → 一个 MCP 处理器。
 *
 * 交付根与账本都从环境变量取默认值（`ABX_OUTBOX_ROOT` / `ABX_TRANSOM_LEDGER`），
 * 于是用例不会往开发者真实的 `~/.abx` 里写东西。
 *
 * **它不需要任何凭据**：处理器收的会话由调用方从舱令牌解出来（见 `server.ts`），
 * 这里只管「递给谁、落到哪儿、记在哪儿」。
 */
export function createTransomRuntime(options: TransomRuntimeOptions): TransomRuntime {
  const outboxRoot = defaultOutboxRoot(options.env)
  const ledgerPath = defaultTransomLedgerPath(options.env)
  const opener = options.opener === undefined ? createSystemOpener() : options.opener
  const ledger = createFileTransomLedger(ledgerPath)
  const service = createTransomService({ outboxRoot, ledger, opener })

  return {
    handler: createTransomMcpHandler({ service }),
    outboxRoot,
    ledgerPath: service.ledgerPath,
    openerName: opener === null ? null : opener.name,
    close: () => ledger.close(),
  }
}

export interface BrokerLease {
  readonly hostOrigin: string
  readonly cellOrigin: string
  readonly cellToken: string
  /** 是我们起的，还是接上了一个已经在跑的。 */
  readonly spawned: boolean
  /**
   * 这次会话的传递窗（`null` = 没有：接上的是别人的 broker）。
   *
   * 它只报「东西落到哪儿」，**不带令牌**：舱内那侧用的是这个舱自己的令牌，
   * 而那一个已经由 `buildCellEnv` 注入给 agent 了，不需要再多一份。
   */
  readonly transom: TransomLease | null
  /**
   * 起舱：登记一个舱并拿到它专属的令牌，顺带登记它的传递窗会话。
   *
   * `session` 里是这次会话的 agentId 与几个可写根（工作目录、状态目录）——
   * 也就是「舱内哪个文件可以被递出来」那个判据。**接上一个已经在跑的 broker 时
   * 登记不了**（注册表在另一个进程里，没有跨进程接口），那种会话的 `/mcp` 会回 409。
   */
  registerCell(cellId: string, session?: TransomSession | null): CellBinding
  /** 舱销毁：注销；返回是否真的删掉了一条。 */
  unregisterCell(cellId: string): boolean
  stop(): Promise<void>
}

export interface EnsureBrokerInput {
  readonly context: CommandContext
  readonly backend: SandboxBackendId
  readonly cellHost: string
  /** 舱面按这个顺序试 bind；不传就只试 `cellHost` 一个（老行为）。 */
  readonly bindHosts?: readonly string[]
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
      // 一个字节都不接：接上的那个 broker 里没有这次会话的交付信息，
      // 而在这里现造一个只会让人以为「传递窗通了」，实际每一条都会 409。
      transom: null,
      registerCell: (cellId) => {
        // 注册表在另一个进程里，没有跨进程接口。这里只能退回默认舱，
        // 说清楚是为了让人知道「这个会话的审计身份不是它自己的 id」。
        input.log(
          `[abx] 注意：接上的是已经在跑的 broker，无法为 ${cellId} 单独注册令牌；` +
            `本次会话使用默认舱 ${DEFAULT_CELL_ID} 的宿主固定令牌。`,
        )
        // 传递窗跟着一起没有：那个进程既不知道这次会话的交付格，也不知道它的可写根，
        // 而这两样正是「哪个文件能递出去」的判据。不猜，直接说清。
        input.log(`[abx] 注意：这次会话的传递窗（publish / open）不可用——broker 不是本次会话起的。`)
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

  // 传递窗在这一侧拼好再交给 broker。放在这里（而不是 broker 内部）是因为它要交付根、
  // 账本和「怎么打开一个文件」——三样都属于会话编排这一侧；broker 只负责把身份解出来。
  //
  // 只在自己起 broker 的那条路上拼：接上别人的 broker 时，那个进程里没有我们的处理器，
  // 拼了也用不上，还会白建一个交付根目录。
  const transom = createTransomRuntime({ env: input.context.env })
  if (transom.openerName === null) {
    input.log(
      `[abx] 注意：这台机器上不知道怎么打开文件，传递窗仍然可用——只是递出来的东西要你自己去 ${transom.outboxRoot} 看。`,
    )
  }

  // 同进程起，不拉子进程。
  //
  // 产品没有命令行，原先那个「拿自己的入口路径再 spawn 一个自己」的做法已经没有入口可指。
  // 更重要的理由是令牌：同进程里是直接传值，**不存在两边对不上**这种失败模式。
  const handle = await startBroker({
    config,
    env: input.context.env,
    cellToken: token,
    cellHost: input.cellHost,
    bindHosts: input.bindHosts,
    transom: transom.handler,
    logger: { info: input.log, warn: input.log, error: input.log },
  })

  return {
    hostOrigin: handle.hostOrigin,
    cellOrigin: handle.cellOrigin,
    cellToken: handle.cellToken,
    spawned: true,
    transom,
    registerCell: (cellId, session) => ({ cellId, token: handle.registerCell(cellId, session), dedicated: true }),
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


