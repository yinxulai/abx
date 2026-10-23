/**
 * 气闸代理的两个监听面。
 *
 *   宿主面 `127.0.0.1:<hostPort>`   给宿主上的桌面客户端用，**不校验令牌**。
 *                                   绑死在回环上，因为它没有鉴权——绑到 0.0.0.0
 *                                   就等于把「读任何已配置上游」的能力开放给整个局域网。
 *   舱面   `<cellHost>:<cellPort>`  给舱内用，**必须校验令牌**。
 *
 * 两个面的处理器是同一个，只有鉴权那一步不同。分成两份实现的话，迟早会出现
 * 「宿主面修了、舱面没修」的洞。
 *
 * 每个请求都会走到同一个收口（`handleRequest`），决策链是固定顺序（舱面）：
 *   来源网段 → 舱令牌 → 舱身份 → 路由 → 白名单 → 凭据 → 转发 → 审计
 * 顺序本身也是安全属性，有两处：
 *
 *   - **来源在令牌之前**：来源不对的连接根本不该走到令牌比对那一步。否则一个
 *     网段外的探测者能拿「令牌对不对」的响应差异（401 还是 403）当 oracle，
 *     把舱令牌一位一位试出来——而它打进来的这件事本身已经在审计里了。
 *   - **白名单在凭据之前**：不在白名单的域名**不会**让 broker 去读它的密钥。
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { formatBytes, type AbxConfig } from '@abx/contracts'
import { buildUpstreamIndex } from '../policy/index'
import type { TransomMcpHandler } from '../transom/mcp'
import type { TransomSession } from '../transom/service'
import {
  DEFAULT_ALLOWED_CELL_SUBNETS,
  classifyCellSource,
  findInvalidCellSubnets,
  normalizeRemoteAddress,
} from './cell-source'
import { createFileAuditSink, type AuditDecision, type AuditSink, type BrokerFace } from './audit'
import type { SecretDependencies } from './credentials'
import { forwardRequest, writeJson } from './forward'
import { CellTokenRegistry, DEFAULT_CELL_REGISTRY_LIMIT } from './registry'
import { CELL_ID_HEADER, CELL_TOKEN_HEADER, extractCellToken, resolveRoute } from './route'
import { resolveTarget } from './target'
import { generateCellToken } from './token'

/**
 * 宿主固定令牌绑定的舱。
 *
 * 环境变量 / 显式传入的令牌不是给某个真实会话的，而是 `abx broker` 与
 * `abx open` 之间传值用的（以及开发自测）。它只对应这一个「默认舱」：
 * 令牌仍然必须存在、仍要能反查，只是反查出来的身份固定。
 */
export const DEFAULT_CELL_ID = 'default'

export interface BrokerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const consoleLogger: BrokerLogger = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
}

/**
 * MCP 请求体的上限：64 KiB。
 *
 * 一条 JSON-RPC 消息里装的是路径、名字和参数——几百字节。上限存在的理由是
 * 「舱内进程能反复触发」，而这个请求体是**读进 broker 进程内存**的：没有上限，
 * 一个跑飞的 agent 能用几条请求把宿主上这个进程的内存吃掉。
 *
 * 拒绝而不是截断：截断出来的是半条 JSON，报错会变成「解析不了」，
 * 而真正的原因（太大了）就再也看不见了。
 */
export const MCP_MAX_REQUEST_BYTES = 64 * 1024

/** 审计条目里那些「这次请求额外发生了什么」的字段。 */
interface AuditExtra {
  readonly upstreamId?: string | null
  readonly targetHost?: string | null
  readonly credentialInjected?: boolean
}

export type CellTokenSource = 'explicit' | 'env' | 'ephemeral'

export interface BrokerOptions {
  readonly config: AbxConfig
  readonly env: Readonly<Record<string, string | undefined>>
  /** 注入读文件，测试里用来喂一个假的凭据文件。 */
  readonly readFile?: (path: string) => string
  readonly auditSink?: AuditSink
  /** 显式指定舱令牌。不给就从环境变量读，再不给就临时生成。 */
  readonly cellToken?: string | null
  /** 覆盖 `broker.cellHost`。local 后端会把它改成回环地址。 */
  readonly cellHost?: string | null
  /**
   * 舱面按这个顺序试 bind，第一个成功的算数。
   *
   * 为什么不是一个地址：**「绑哪」和「告诉舱内哪个地址」是两件事**（见
   * `cell-host.ts`）。原生 linux docker 上配置里那个 `172.17.0.1` 是真实网卡，
   * 绑它最窄；Docker Desktop 上没有这个网卡，得退到 `0.0.0.0`。给调用方算这个
   * 顺序（`bindHostCandidates()`），这里只负责依次试——判定留在纯函数那一侧，
   * 才验得了。
   *
   * 不传就是老样子：只试 `cellHost` 一个，失败即失败。
   */
  readonly bindHosts?: readonly string[]
  /** 覆盖端口，测试里用 0 让系统分配。 */
  readonly hostPort?: number | null
  readonly cellPort?: number | null
  /** 同时登记的舱上限（含默认舱）。默认 64。 */
  readonly cellRegistryLimit?: number | null
  /**
   * 舱面接受的来源网段（IPv4 CIDR）。默认 {@link DEFAULT_ALLOWED_CELL_SUBNETS}。
   *
   * **这是配置项 `broker.allowedCellSubnets` 的过渡落点。** 配置层合并之后，
   * 这个字段由 `packages/contracts/source/config.ts` 的 `BrokerConfig` 承载、
   * 在 `load-config.ts` 里解析并给出默认值，`commands/` 再把它递进来；
   * 在那之前只从代码传，别为了它去改 `packages/contracts/**`。
   *
   * 空数组 = 全部拒绝，这是有意的默认方向：判不了就不放行。
   */
  readonly allowedCellSubnets?: readonly string[] | null
  /**
   * 传递窗的 MCP 处理器（`/mcp`）。不传就是「这次没接传递窗」——那条路由会回 503。
   *
   * 为什么处理器由调用方给、而不是 broker 自己造：它需要交付根、账本和一个打开文件的
   * 实现（`createTransomService`），而那三样都属于会话编排那一侧。broker 只做一件事：
   * **把身份解出来，然后把消息交给处理器**。
   */
  readonly transom?: TransomMcpHandler | null
  readonly logger?: BrokerLogger
}

export interface BrokerHandle {
  readonly hostOrigin: string
  readonly cellOrigin: string
  /** 宿主固定令牌（默认舱用）。按舱分配的令牌请走 {@link registerCell}。 */
  readonly cellToken: string
  readonly cellTokenSource: CellTokenSource
  readonly audit: AuditSink
  readonly config: AbxConfig
  /** 令牌 → 舱 id 的注册表。 */
  readonly registry: CellTokenRegistry
  /** 起舱时登记，返回该舱专属令牌。顺带登记这个舱的传递窗会话（有的话）。 */
  registerCell(cellId: string, session?: TransomSession | null): string
  /** 舱销毁时注销；注销之后原令牌立刻失效。 */
  unregisterCell(cellId: string): boolean
  close(): Promise<void>
}

export async function startBroker(options: BrokerOptions): Promise<BrokerHandle> {
  const { config } = options
  const log = options.logger ?? consoleLogger
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const audit = options.auditSink ?? createFileAuditSink(config.broker.auditPath)

  const secrets: SecretDependencies = { env: options.env, readFile }
  const upstreamIndex = buildUpstreamIndex(config.upstreams)

  const token = resolveCellToken(config, options, log)
  const cellHost = options.cellHost ?? config.broker.cellHost
  const allowedCellSubnets = options.allowedCellSubnets ?? DEFAULT_ALLOWED_CELL_SUBNETS

  // 固定令牌也要在表里，但只对应一个默认舱。它不是「绕过注册表」的口子：
  // 舱面校验仍然要求令牌能在表里查到，只是查出来的身份固定。
  const registry = new CellTokenRegistry({ limit: options.cellRegistryLimit ?? DEFAULT_CELL_REGISTRY_LIMIT })
  registry.registerFixed(DEFAULT_CELL_ID, token.value)

  const handler = createHandler({
    config,
    secrets,
    audit,
    log,
    registry,
    upstreamIndex,
    allowedCellSubnets,
    transom: options.transom ?? null,
  })

  const hostServer = http.createServer((request, response) => handler('host', request, response))
  const cellServer = http.createServer((request, response) => handler('cell', request, response))

  let hostAddress: AddressInfo
  try {
    hostAddress = await listen(hostServer, config.broker.host, options.hostPort ?? config.broker.hostPort, '宿主面')
  } catch (error) {
    throw new Error(`宿主面起不来（broker.host=${config.broker.host} broker.hostPort=${config.broker.hostPort}）：${message(error)}`)
  }

  const bindHosts = options.bindHosts ?? [cellHost]
  let cellAddress: AddressInfo | null = null
  let lastBoundHost = bindHosts[0] ?? cellHost
  const bindFailures: string[] = []
  for (const candidate of bindHosts) {
    try {
      cellAddress = await listen(cellServer, candidate, options.cellPort ?? config.broker.cellPort, '舱面')
      lastBoundHost = candidate
      if (candidate !== bindHosts[0]) {
        // 退让过就要说出来：绑在 `0.0.0.0` 上意味着这一台机器的**所有**网卡都能
        // 打到舱面，而这跟配置里写的那个地址不是一回事。
        log.warn(`[abx] 舱面绑不上 ${bindHosts[0]}，已改绑 ${candidate}（这一台机器的所有网卡都能打到舱面）`)
      }
      break
    } catch (error) {
      bindFailures.push(`${candidate}：${message(error)}`)
    }
  }

  if (cellAddress === null) {
    hostServer.close()
    hostServer.closeAllConnections()
    throw new Error(
      `舱面起不来（broker.cellPort=${config.broker.cellPort}）。试过这些地址：\n` +
        bindFailures.map((failure) => `  - ${failure}`).join('\n') +
        `\n  docker 没起来时网桥地址并不存在。用 local 后端跑的时候请把 cellHost 指到 127.0.0.1，或者设 session.backend=docker。`,
    )
  }

  const hostOrigin = `http://${config.broker.host}:${hostAddress.port}`
  // 舱内被告知的是**配置里那个**地址，不是 bind 成功的那一个：退到 `0.0.0.0`
  // 只是「这台机器愿意在这个网卡上收」，而 `0.0.0.0` 对容器来说不是一个能连的地址。
  // 容器真正该打哪儿由 `decideCellHost()` 探测决定（见 `cell-host.ts`）。
  const cellOrigin = `http://${formatHostForUrl(cellHost)}:${cellAddress.port}`

  log.info(`[abx] 宿主面 ${hostOrigin}（不校验令牌，绑在回环上）`)
  log.info(`[abx] 舱面   ${cellOrigin}（校验 ${CELL_TOKEN_HEADER}）`)
  // 绑的地址与告诉舱内的地址是两件事，两个不一致时要说出来：读日志的人看到
  // 「舱面 http://host.docker.internal:8789」会以为宿主上也这么绑着。
  if (lastBoundHost !== cellHost) {
    log.info(`[abx] 舱面实际绑在 ${lastBoundHost}:${cellAddress.port}（告诉舱内的是 ${cellHost}，两者不是一回事）`)
  }
  if (lastBoundHost === '0.0.0.0') {
    // 这一条要在启动时说，不能只在被拒的审计记录里体现：绑 0.0.0.0 意味着
    // 宿主机所在的**整个局域网**都能打到舱面。鉴权还有（舱令牌 + 来源网段），
    // 但「哪些机器能打到」这件事变了，用户有权知道。
    log.warn('[abx] 舱面绑在 0.0.0.0：这台机器的所有网卡都能打到它（仍然要舱令牌，来源也仍然按网段过滤）')
  }
  log.info(`[abx] 舱面来源 ${allowedCellSubnets.length === 0 ? '（空：全部拒绝）' : allowedCellSubnets.join(', ')}`)
  // 网段写错的唯一表现是「所有来源都 403」——包括舱里正常的 agent，且没有任何
  // 别的线索。所以启动时就要把它喊出来，而不是等人对着审计猜。
  const invalidSubnets = findInvalidCellSubnets(allowedCellSubnets)
  if (invalidSubnets.length > 0) {
    log.warn(`[abx] 舱面来源网段里有 ${invalidSubnets.length} 条写错了，不会生效：${invalidSubnets.join('、')}`)
  }
  log.info(`[abx] 审计   ${audit.describe}`)
  if (token.source === 'ephemeral') {
    log.warn(
      `[abx] 环境变量 ${config.broker.cellTokenEnv} 没设置，已生成一次性舱令牌。` +
        `要让另一个进程也能连上舱面，请显式设置它，或用 abx broker 落盘的令牌文件。`,
    )
  }

  let closed = false
  return {
    hostOrigin,
    cellOrigin,
    cellToken: token.value,
    cellTokenSource: token.source,
    audit,
    config,
    registry,
    registerCell: (cellId, session) => registry.register(cellId, session),
    unregisterCell: (cellId) => registry.unregister(cellId),
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await Promise.all([closeServer(hostServer), closeServer(cellServer)])
      // 审计 sink 的错误在 close 时抛出：调用方（测试 / CLI）需要知道
      // 「这次运行里有记录没落盘」，而不是让它静默消失。
      await audit.close()
    },
  }
}

interface HandlerContext {
  readonly config: AbxConfig
  readonly secrets: SecretDependencies
  readonly audit: AuditSink
  readonly log: BrokerLogger
  readonly registry: CellTokenRegistry
  readonly upstreamIndex: ReturnType<typeof buildUpstreamIndex>
  readonly allowedCellSubnets: readonly string[]
  readonly transom: TransomMcpHandler | null
}

function createHandler(context: HandlerContext) {
  const { config, audit, log, registry, upstreamIndex, allowedCellSubnets, transom } = context

  return (face: BrokerFace, request: IncomingMessage, response: ServerResponse): void => {
    const startedAt = performance.now()
    handleRequest(face, request, response, startedAt).catch((error: unknown) => {
      log.error(`[abx] 处理请求时出错：${message(error)}`)
      writeJson(response, 500, { error: 'abx_internal_error' })
    })
  }

  async function handleRequest(face: BrokerFace, request: IncomingMessage, response: ServerResponse, startedAt: number): Promise<void> {
    const method = request.method ?? 'GET'
    // 固定一个 base：请求行是 origin-form（`/u/x/y`），没有 base 就解析不了。
    // 用假域名而不是 `Host` 头，免得一个畸形 Host 让整条流水线在解析阶段就抛。
    const url = new URL(request.url ?? '/', 'http://abx.invalid')

    const extraction = extractCellToken(
      { pathname: url.pathname, headers: request.headers },
      { allowInPath: config.broker.allowCellTokenInPath },
    )
    // 审计里记的是**剥掉令牌之后**的路径。记原文的话，走 `/c/<token>/` 那条路的
    // 请求会把舱令牌一字不差地写进审计文件——审计文件恰恰是最容易被收集走的东西。
    const auditPath = `${extraction.pathname}${url.search}`
    // 来源取对端地址，**不读任何请求头**：请求头是请求方自己能写的。
    // 只归一化一次，判定和审计用的是同一个值（`null` = 拿不到，判定那侧当 undefined）。
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress)
    // 宿主面没有舱身份。舱面的身份在下面由令牌反查得出，**不读请求头**：
    // 请求头是外部输入，只能用来做「与令牌绑定值是否一致」的辅助检查。
    let cellId = face === 'cell' ? 'unknown-cell' : 'host'

    const writeAudit = (decision: AuditDecision, status: number, extra: AuditExtra): Promise<void> =>
      audit.write({
        ts: new Date().toISOString(),
        cellId,
        sourceAddress: remoteAddress,
        method,
        path: auditPath,
        upstreamId: extra.upstreamId ?? null,
        targetHost: extra.targetHost ?? null,
        decision,
        status,
        durationMs: performance.now() - startedAt,
        credentialInjected: extra.credentialInjected ?? false,
        face,
      })

    // ── 1. 来源网段。只对舱面，且必须在令牌之前。 ───────────────────────────
    //
    // 顺序是**刻意的**：来源不对的连接不该走到令牌比对那一步。放在令牌之后的话，
    // 网段外的探测者就能拿「401 还是 403」的差别判断令牌猜中没猜中——一次一位，
    // 这就是个 oracle。放在前面，网段外的请求无论带什么令牌都是同一个 403。
    //
    // 宿主面不判来源：它绑死在回环上，没有鉴权，能连上它的本来就只有本机；
    // 这里再加一道只会让本机的桌面客户端被自己的配置绊倒。
    if (face === 'cell') {
      const source = classifyCellSource(remoteAddress ?? undefined, allowedCellSubnets)
      if (!source.allowed) {
        writeJson(response, 403, {
          // 只说「你不在网段里」，不说允许的是哪些：告诉打进来的人网段范围，
          // 等于把「从哪台机器能打」这份地图送给他。
          error: 'abx_cell_source_denied',
          detail: '来源地址不在舱面允许的网段内',
        })
        await writeAudit('denied-cell-source', 403, {})
        return
      }
    }

    // ── 2. 舱令牌与舱身份。宿主面不走这一步。 ───────────────────────────────
    if (face === 'cell') {
      const provided = extraction.token
      // 令牌必须存在，并且**反查得出**舱 id。未知令牌不猜身份。
      const boundCellId = provided === null ? null : registry.resolve(provided)
      if (boundCellId === null) {
        writeJson(response, 401, {
          error: 'abx_cell_token_required',
          detail: `舱面要求 ${CELL_TOKEN_HEADER} 头，或 /c/<token>/ 路径前缀`,
        })
        await writeAudit('denied-cell-token', 401, {})
        return
      }

      // 辅助检查：舱内自报的 id 只用来「和令牌绑定值对一下」。对不上就拒绝，
      // 免得一个舱拿着自己的令牌在审计里冒充另一个舱。
      const claimed = headerValue(request.headers[CELL_ID_HEADER])
      if (claimed !== undefined && claimed !== '' && claimed !== boundCellId) {
        cellId = boundCellId
        writeJson(response, 401, {
          error: 'abx_cell_id_mismatch',
          detail: `请求头 ${CELL_ID_HEADER} 与令牌绑定的舱不一致`,
        })
        await writeAudit('denied-cell-identity', 401, {})
        return
      }

      cellId = boundCellId
    }

    // ── 3. 路由。 ────────────────────────────────────────────────────────
    const route = resolveRoute({ pathname: extraction.pathname, search: url.search, headers: request.headers })

    /**
     * 传递窗（`/mcp`）。
     *
     * 三步：**认得这个舱 → 读一条消息 → 交给处理器**。身份那一侧没有任何新东西：
     * 上面第 1、2 步已经做过来源与令牌，`cellId` 是从令牌反查出来的，请求体里
     * 说什么都不影响它是谁。
     *
     * 只挂在舱面。宿主面没有身份可解，而传递窗做的每一件事（把文件写进宿主的交付格、
     * 让宿主打开它）都要落到**某个**舱头上；在一个不校验身份的面上提供这个能力，
     * 等于让本机任何一个进程拿别人的名义递东西。所以宿主面上直接拒。
     */
    async function handleTransom(response: ServerResponse, incoming: IncomingMessage): Promise<void> {
      if (face !== 'cell') {
        writeJson(response, 403, {
          error: 'abx_transom_cell_face_only',
          detail: '传递窗挂在舱面：它要按舱记身份，而宿主面不校验身份',
        })
        await writeAudit('denied-route', 403, {})
        return
      }
      if (transom === null) {
        // 这个 broker 进程没有接传递窗。说清楚是「没接」，不是「坏了」。
        writeJson(response, 503, {
          error: 'abx_transom_unavailable',
          detail: '这个 broker 没有接传递窗（没有传 transom）；用 abx open 起的会话会接上它',
        })
        await writeAudit('denied-route', 503, {})
        return
      }

      const session = registry.session(cellId)
      if (session === null) {
        // 令牌有效但没登记交付信息：最常见的一种是「接上了一个已经在跑的 broker」——
        // 那个进程里的注册表不认这次会话。这时**不能猜**一个默认的交付格与根：
        // 猜出来的根就是「舱内哪个文件能递出去」那个判据本身。
        writeJson(response, 409, {
          error: 'abx_transom_session_unknown',
          detail: `舱 ${cellId} 没有登记传递窗会话（交付格与可写根都不知道）。这个 broker 不是本次会话起的。`,
        })
        await writeAudit('denied-route', 409, {})
        return
      }

      const body = await readBody(incoming, MCP_MAX_REQUEST_BYTES)
      if (!body.ok) {
        writeJson(response, 413, { error: 'abx_transom_body_too_large', detail: body.reason })
        await writeAudit('denied-route', 413, {})
        return
      }

      // 名字不叫 `message`：那个名字在这个文件里是「把错误说成一句话」的函数，
      // 遮住它会让下面几句报错信息变成编译错误（真的发生过）。
      let rpcMessage: unknown
      try {
        rpcMessage = JSON.parse(body.text)
      } catch (error) {
        // JSON-RPC 说解析不了的请求要回 -32700，id 写 null。回一个 HTTP 400 的话，
        // 客户端的 MCP 实现会把它当成传输层的失败，而不是「这条消息我读不懂」。
        writeJson(response, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `请求体不是合法的 JSON：${message(error)}` },
        })
        await writeAudit('denied-route', 400, {})
        return
      }

      let reply: unknown | null
      try {
        reply = await transom.handle(rpcMessage, session)
      } catch (error) {
        // 处理器抛了说明是 abx 自己出了问题（不是「工具被拒绝」——那条路是
        // `result.isError`）。回一条 JSON-RPC 错误，让舱内那个 agent 至少能说出
        // 「传递窗内部出错了」，而不是连不上。
        log.error(`[abx] 传递窗处理请求时出错：${message(error)}`)
        writeJson(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `传递窗内部出错：${message(error)}` } })
        await writeAudit('denied-route', 500, {})
        return
      }

      if (reply === null) {
        // 通知：受理了，但没有回复体。202 而不是 204，是为了让「收到了但没什么可说」
        // 与「路径不对」在日志里能分开。
        response.writeHead(202)
        response.end()
      } else {
        writeJson(response, 200, reply)
      }
      // 审计记的是**这次网络请求**：哪个舱、什么时候、几条消息、回的是哪一类。
      // 每一份文件递出去这件事记在传递窗自己的账上（更细，见 transom/ledger.ts）。
      // 两份流水不合并：这里答「谁在什么时候打了什么」，那里答「哪个文件去哪儿了」。
      await writeAudit('allowed', 200, {})
    }

    if (route.kind === 'health') {
      // 健康检查不进审计：探活是秒级的，进去会把真正的访问记录淹掉。
      writeJson(response, 200, {
        ok: true,
        face,
        upstreams: config.upstreams.length,
        egressRules: config.egress.length,
      })
      return
    }

    if (route.kind === 'mcp') {
      await handleTransom(response, request)
      return
    }

    if (route.kind === 'invalid') {
      writeJson(response, 400, { error: 'abx_invalid_route', detail: route.reason })
      await writeAudit('denied-route', 400, {})
      return
    }

    // ── 4+5. 白名单与凭据。 ──────────────────────────────────────────────
    const target = resolveTarget({
      config,
      route,
      search: url.search,
      secrets: context.secrets,
      upstreamsById: upstreamIndex.byId,
      upstreamIndex,
    })

    if (!target.ok) {
      writeJson(response, target.status, {
        error:
          target.decision === 'denied-egress'
            ? 'abx_egress_denied'
            : target.decision === 'denied-unknown-upstream'
              ? 'abx_unknown_upstream'
              : 'abx_credential_unavailable',
        detail: target.detail,
      })
      await writeAudit(target.decision, target.status, {
        upstreamId: target.upstreamId,
        targetHost: target.targetHost,
      })
      return
    }

    // ── 6. 转发。 ────────────────────────────────────────────────────────
    const outcome = await forwardRequest(
      {
        origin: target.origin,
        path: target.path,
        method,
        headers: request.headers,
        body: request,
        timeoutMs: config.broker.requestTimeoutMs,
        auth: target.auth,
      },
      response,
    )

    // ── 7. 审计。记的是「注入了没有」，不是注入了什么。 ────────────────────
    await writeAudit(outcome.ok ? 'allowed' : outcome.kind === 'timeout' ? 'upstream-timeout' : 'upstream-error', outcome.ok ? outcome.status : 502, {
      upstreamId: target.upstreamId,
      targetHost: target.targetHost,
      credentialInjected: target.auth !== null,
    })
  }
}

interface ResolvedCellToken {
  readonly value: string
  readonly source: CellTokenSource
}

function resolveCellToken(config: AbxConfig, options: BrokerOptions, log: BrokerLogger): ResolvedCellToken {
  const explicit = options.cellToken?.trim()
  if (explicit !== undefined && explicit !== '') {
    return { value: explicit, source: 'explicit' }
  }

  const fromEnv = options.env[config.broker.cellTokenEnv]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: 'env' }
  }

  const generated = generateCellToken()
  log.warn(`[abx] 环境变量 ${config.broker.cellTokenEnv} 是空的，本次运行使用一次性舱令牌`)
  return { value: generated, source: 'ephemeral' }
}

/** IPv6 在 URL 里要带方括号，否则 `::1:8789` 会被当成主机名。 */
export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function listen(server: http.Server, host: string, port: number, label: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve(server.address() as AddressInfo)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
    void label
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    // keep-alive 连接会让 close() 一直不回调。代理的客户端（agent 的 HTTP 客户端）
    // 基本都会保持长连接，不主动掐掉的话 close() 会挂住。
    server.closeAllConnections()
  })
}

type ReadBodyResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

/**
 * 读一个请求体，超过上限就回一句理由。
 *
 * 超限之后**继续把流读完再回**，不是立刻掐掉连接：掐掉的话那个 413 根本发不出去，
 * 舱内看到的只是「连接被重置」——而「你的请求体太大了」正是它需要知道的那句话。
 * 继续读不再往数组里放，所以内存是有界的；天真的发送方由 node 自己的 requestTimeout 收尾。
 */
async function readBody(request: IncomingMessage, limit: number): Promise<ReadBodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  let overflowed = false

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > limit) {
      overflowed = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }

  if (overflowed) {
    return { ok: false, reason: `MCP 请求体超过上限 ${formatBytes(limit)}。一条 JSON-RPC 消息只有几百字节，这个大小不对。` }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value[0]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
