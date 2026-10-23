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
 * 每个请求都会走到同一个收口（`handleRequest`），决策链是固定顺序：
 *   舱令牌 → 路由 → 白名单 → 凭据 → 转发 → 审计
 * 顺序本身也是安全属性：白名单在凭据之前，所以一个不在白名单的域名
 * **不会**让 broker 去读它的密钥。
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { AbxConfig } from '@abx/contracts'
import { buildUpstreamIndex } from '../policy/index'
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
  /** 覆盖端口，测试里用 0 让系统分配。 */
  readonly hostPort?: number | null
  readonly cellPort?: number | null
  /** 同时登记的舱上限（含默认舱）。默认 64。 */
  readonly cellRegistryLimit?: number | null
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
  /** 起舱时登记，返回该舱专属令牌。 */
  registerCell(cellId: string): string
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
  })

  const hostServer = http.createServer((request, response) => handler('host', request, response))
  const cellServer = http.createServer((request, response) => handler('cell', request, response))

  let hostAddress: AddressInfo
  try {
    hostAddress = await listen(hostServer, config.broker.host, options.hostPort ?? config.broker.hostPort, '宿主面')
  } catch (error) {
    throw new Error(`宿主面起不来（broker.host=${config.broker.host} broker.hostPort=${config.broker.hostPort}）：${message(error)}`)
  }

  let cellAddress: AddressInfo
  try {
    cellAddress = await listen(cellServer, cellHost, options.cellPort ?? config.broker.cellPort, '舱面')
  } catch (error) {
    hostServer.close()
    hostServer.closeAllConnections()
    throw new Error(
      `舱面起不来（broker.cellHost=${cellHost} broker.cellPort=${config.broker.cellPort}）：${message(error)}\n` +
        `  docker 没起来时 ${config.broker.cellHost} 这个网桥地址并不存在。` +
        `用 local 后端跑的时候请把 cellHost 指到 127.0.0.1，或者设 session.backend=docker。`,
    )
  }

  const hostOrigin = `http://${config.broker.host}:${hostAddress.port}`
  const cellOrigin = `http://${formatHostForUrl(cellHost)}:${cellAddress.port}`

  log.info(`[abx] 宿主面 ${hostOrigin}（不校验令牌，绑在回环上）`)
  log.info(`[abx] 舱面   ${cellOrigin}（校验 ${CELL_TOKEN_HEADER}）`)
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
    registerCell: (cellId) => registry.register(cellId),
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
}

function createHandler(context: HandlerContext) {
  const { config, audit, log, registry, upstreamIndex } = context

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
    // 宿主面没有舱身份。舱面的身份在下面由令牌反查得出，**不读请求头**：
    // 请求头是外部输入，只能用来做「与令牌绑定值是否一致」的辅助检查。
    let cellId = face === 'cell' ? 'unknown-cell' : 'host'

    const writeAudit = (decision: AuditDecision, status: number, extra: AuditExtra): Promise<void> =>
      audit.write({
        ts: new Date().toISOString(),
        cellId,
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

    // ── 1. 舱令牌与舱身份。宿主面不走这一步。 ───────────────────────────────
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

    // ── 2. 路由。 ────────────────────────────────────────────────────────
    const route = resolveRoute({ pathname: extraction.pathname, search: url.search, headers: request.headers })

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

    if (route.kind === 'invalid') {
      writeJson(response, 400, { error: 'abx_invalid_route', detail: route.reason })
      await writeAudit('denied-route', 400, {})
      return
    }

    // ── 3+4. 白名单与凭据。 ──────────────────────────────────────────────
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

    // ── 5. 转发。 ────────────────────────────────────────────────────────
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

    // ── 6. 审计。记的是「注入了没有」，不是注入了什么。 ────────────────────
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

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value[0]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
