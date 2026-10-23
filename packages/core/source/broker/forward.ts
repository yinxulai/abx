/**
 * 真正把请求发出去的那一层。
 *
 * 出站头的处理规则，一条一条写清楚，因为「哪些头该留、哪些该扔」是这类代理最容易
 * 出错的地方，而且错了通常表现为「某个 API 偶尔 400」，很难查：
 *
 *   - 逐跳头（`connection` / `transfer-encoding` / `upgrade` …）全部丢掉，它们只对
 *     相邻的那一跳有意义，原样转发会让下游误判连接的形状；
 *   - `host` 重写成目标的 host，否则虚拟主机托管的上游会路由到别人家；
 *   - `x-abx-*` 全部丢掉：那是这套代理的控制面，不该出现在外面；
 *   - 认证头**无条件**覆盖成真实密钥（`auth` 不为 null 时），或者删掉（为 null 时）。
 *     「覆盖」是字面意思：舱内发来什么值都不看，也不校验。
 */

import http from 'node:http'
import https from 'node:https'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'

/**
 * 逐跳头。清单来自 RFC 9110 §7.6.1，多带了几个历史遗留的
 * `proxy-*`：它们同样是「只对相邻一跳有意义」。
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

export interface OutboundAuth {
  readonly header: string
  readonly value: string
}

export interface ForwardOptions {
  readonly origin: URL
  readonly path: string
  readonly method: string
  readonly headers: IncomingHttpHeaders
  readonly body: Readable
  readonly timeoutMs: number
  /** `null` 表示这次不注入凭据，并且要把舱内带来的认证头全部剥掉。 */
  readonly auth: OutboundAuth | null
}

export type ForwardOutcome =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly kind: 'timeout'; readonly detail: string }
  | { readonly ok: false; readonly kind: 'error'; readonly detail: string }

/**
 * 算出要发给上游的头。
 *
 * 单独导出是为了能直接断言：凭据注入的测试如果只能透过一个真的 HTTP 服务去看，
 * 那它验证的是「服务收到了什么」，而这里要保证的是「我们发了什么」——
 * 后者才是出事时定责的依据。
 */
export function buildOutboundHeaders(incoming: IncomingHttpHeaders, origin: URL, auth: OutboundAuth | null): Record<string, string | string[]> {
  const outbound: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'host') continue
    if (lower.startsWith('x-abx-')) continue
    outbound[lower] = value
  }

  // 舱内带来的认证头一律清掉，不管它叫什么。清的是「所有可能是凭据的形态」，
  // 而不是只清配置里那一个头名——舱内完全可以发一个 `x-api-key` 而我们只配了
  // `authorization`，只按配置清就会把它漏出去。
  for (const name of STRIPPED_HEADERS) delete outbound[name]

  if (auth !== null) outbound[auth.header] = auth.value

  outbound['host'] = origin.host
  return outbound
}

/**
 * 不带凭据时也要剥掉的头。
 *
 * 和 `target.ts` 里那份是同一个意思，但那份管的是「决策」，这份管的是「出站」。
 * 两份都在，是因为出站这一层必须自己站得住：就算上面的决策逻辑将来被改坏，
 * 一个占位符也不该有机会流到外面去。
 */
const STRIPPED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
]

export function pickTransport(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http
}

/**
 * 转发一次请求，并把上游的响应原样写回 `response`。
 *
 * 流式：请求体和响应体都不在内存里落地。代理是最不该有缓冲区的地方——
 * 一个 100MB 的上传会把内存限额变成事实上的请求大小限额。
 */
export async function forwardRequest(options: ForwardOptions, response: ServerResponse): Promise<ForwardOutcome> {
  const transport = pickTransport(options.origin.protocol)

  return await new Promise<ForwardOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: ForwardOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const request = transport.request(
      {
        protocol: options.origin.protocol,
        hostname: options.origin.hostname,
        port: options.origin.port === '' ? undefined : Number(options.origin.port),
        method: options.method,
        path: options.path,
        headers: buildOutboundHeaders(options.headers, options.origin, options.auth),
      },
      (upstreamResponse) => {
        const headers = { ...upstreamResponse.headers }
        for (const name of HOP_BY_HOP_HEADERS) delete headers[name]
        response.writeHead(upstreamResponse.statusCode ?? 502, headers)
        upstreamResponse.pipe(response)
        upstreamResponse.on('end', () => settle({ ok: true, status: upstreamResponse.statusCode ?? 502 }))
        upstreamResponse.on('error', (error: Error) => {
          // 响应头已经发出去了，这里没法再改状态码，只能把连接掐掉，
          // 让客户端知道这次响应不完整。
          response.destroy(error)
          settle({ ok: false, kind: 'error', detail: `上游响应中断：${error.message}` })
        })
      },
    )

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('timeout'))
      settle({ ok: false, kind: 'timeout', detail: `上游 ${options.timeoutMs}ms 内没有响应` })
    })

    request.on('error', (error: Error) => {
      const kind = error.message === 'timeout' ? 'timeout' : 'error'
      if (!response.headersSent) {
        // 502 而不是 500：错在「上游那一跳」，不是代理自己。
        writeJson(response, 502, { error: 'abx_upstream_unreachable', detail: error.message })
      } else {
        response.destroy(error)
      }
      settle({ ok: false, kind, detail: `连不上上游 ${options.origin.host}：${error.message}` })
    })

    // 请求体直接接上去。上游提前关连接时 `body` 会 error，这里吞掉：
    // 真正的结论已经由 `request` 的 error 给出了，再抛一次只会多一条噪音。
    options.body.on('error', () => undefined)
    options.body.pipe(request)
  })
}

export function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 拒绝的原因不应该被任何中间层缓存。
    'cache-control': 'no-store',
  })
  response.end(body)
}
