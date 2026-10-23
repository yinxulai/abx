/**
 * 请求 → 路由。纯字符串处理，不碰网络。
 *
 * 三种形态：
 *
 *   `GET /u/anthropic/v1/messages`        → 走配置好的上游，路径拼到它的 baseUrl 后面
 *   `GET /v1/messages` + `X-Abx-Target: https://api.openai.com`
 *                                        → 直通：放行白名单里的域名，路径原样带过去
 *   `GET /healthz`                       → 健康检查，不进审计
 *
 * 舱面还多一层：令牌可以放在 `X-Abx-Cell` 头里，也可以放在 `/c/<token>/` 前缀里。
 * 前缀这一路的代价是令牌会出现在 URL 里，好处是任何 HTTP 客户端都能用——
 * 真实的 agent 命令行未必支持自定义请求头。取舍写在 `BrokerConfig.allowCellTokenInPath`。
 */

import { TRANSOM_ENDPOINT_PATH } from '@abx/contracts'

/** 传递窗的 MCP 端点路径。定义在 contracts，舱内那侧（shim）用的是同一个值。 */
export { TRANSOM_ENDPOINT_PATH }

/** 直通模式下目标地址从哪个头来。值形如 `https://api.openai.com`。 */
export const TARGET_HEADER = 'x-abx-target'
/** 舱令牌的请求头。 */
export const CELL_TOKEN_HEADER = 'x-abx-cell'
/** 舱内自报的会话 id，只进审计，不参与鉴权。 */
export const CELL_ID_HEADER = 'x-abx-cell-id'
/** 舱令牌写在路径里的前缀。 */
export const CELL_PATH_PREFIX = '/c/'
/** 上游路由前缀。 */
export const UPSTREAM_PATH_PREFIX = '/u/'
/** 只有前缀、没有 id 的那一种，单独判成无效路由。 */
const UPSTREAM_BARE_PREFIX = '/u'

export type BrokerRoute =
  | { readonly kind: 'health' }
  /**
   * 传递窗的 MCP 端点（`/mcp`）。
   *
   * 它是**服务**，不是转发：请求体是一条 JSON-RPC 消息，处理器在宿主这一侧跑
   * （见 `transom/mcp.ts`）。所以它必须在路由这一层单独判出来——落进直通那条路的话，
   * 一个没有目标头的 `/mcp` 会得到「不知道该转发到哪儿」。
   *
   * 判定放在直通**前面**，且只在没有目标头时才认：显式说了要去哪儿就以那个为准
   * （`/mcp` 也可能正是某个上游的端点）。绕过传递窗不需要防——它是「递东西给人看」
   * 的通道，不是一个必须经过的闸门。
   */
  | { readonly kind: 'mcp' }
  | {
      readonly kind: 'upstream'
      readonly upstreamId: string
      /** 拼到上游 baseUrl 后面的路径，一定以 `/` 开头。 */
      readonly path: string
    }
  | {
      readonly kind: 'passthrough'
      /** 直通目标，已经解析成 URL。 */
      readonly target: URL
      readonly path: string
    }
  | { readonly kind: 'invalid'; readonly reason: string }

export interface RouteInput {
  /** 去掉舱令牌前缀之后的路径。 */
  readonly pathname: string
  /** 带上 `?`，没有查询串就是空串。 */
  readonly search: string
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

export function resolveRoute(input: RouteInput): BrokerRoute {
  if (input.pathname === '/healthz') return { kind: 'health' }

  if (input.pathname === UPSTREAM_BARE_PREFIX || input.pathname.startsWith(UPSTREAM_PATH_PREFIX)) {
    return resolveUpstreamRoute(input.pathname)
  }

  // 目标头是空串时按「没写」算，与直通那侧的判法一致（`resolvePassthroughRoute` 也把
  // 空串当成没写）。不然一个 `X-Abx-Target: ` 空头就会让 /mcp 掉进直通，回一句
  // 「没有带 x-abx-target 头」——而它明明带了。
  const target = firstHeaderValue(input.headers[TARGET_HEADER])
  if (input.pathname === TRANSOM_ENDPOINT_PATH && (target === undefined || target === '')) {
    return { kind: 'mcp' }
  }

  return resolvePassthroughRoute(input)
}

/**
 * `/u/<id>` 与 `/u/<id>/<rest>`。
 *
 * `/u` 单独一个是无效路由而不是「第一个上游」：路由里少一段却静默命中某个上游，
 * 是那种上线三个月后才被发现的 bug。
 */
function resolveUpstreamRoute(pathname: string): BrokerRoute {
  const rest = pathname.slice(UPSTREAM_PATH_PREFIX.length)
  if (rest === '') {
    return { kind: 'invalid', reason: `上游路由要写成 ${UPSTREAM_PATH_PREFIX}<upstreamId>/<path>` }
  }

  const slash = rest.indexOf('/')
  const upstreamId = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? '' : rest.slice(slash)

  if (upstreamId === '') {
    return { kind: 'invalid', reason: '上游路由里没写 upstreamId' }
  }

  return { kind: 'upstream', upstreamId: decodeURIComponent(upstreamId), path: tail === '' ? '/' : tail }
}

function resolvePassthroughRoute(input: RouteInput): BrokerRoute {
  const raw = firstHeaderValue(input.headers[TARGET_HEADER])
  if (raw === undefined || raw === '') {
    return {
      kind: 'invalid',
      reason: `没有 ${UPSTREAM_PATH_PREFIX}<upstreamId>/ 前缀，也没有带 ${TARGET_HEADER} 头，不知道该转发到哪儿`,
    }
  }

  let target: URL
  try {
    // 没写协议就按 https 补。直通的目标几乎都是公网 API，
    // 补 http 会让一个漏写协议头的配置悄悄降级成明文。
    target = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return { kind: 'invalid', reason: `${TARGET_HEADER} 不是合法的地址：${JSON.stringify(raw)}` }
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { kind: 'invalid', reason: `${TARGET_HEADER} 只支持 http / https，实际是 ${target.protocol}` }
  }

  return { kind: 'passthrough', target, path: `${input.pathname}${input.search}` }
}

export type CellTokenSource = 'header' | 'path'

export interface CellTokenExtraction {
  /** 请求里带的令牌，没带就是 `null`。 */
  readonly token: string | null
  readonly source: CellTokenSource | null
  /** 去掉 `/c/<token>` 前缀之后的路径；没走前缀就是原路径。 */
  readonly pathname: string
}

/**
 * 从请求里取出舱令牌。
 *
 * 请求头优先于路径：两个都带的时候，以请求头为准，避免「路径里带了一个旧令牌、
 * 请求头里带了新的」这种半新半旧的状态产生一个难以复现的 401。
 *
 * **但路径前缀无论如何都要剥掉。** 这一点是被端到端跑出来的：
 * `allowCellTokenInPath` 是配置里的全局开关，而 `X-Abx-Cell` 头是 agent 注册表
 * 通过 `ANTHROPIC_CUSTOM_HEADERS` 加的，两个开关互相独立、默认都开着。
 * 于是真实的 `abx open claude` 发出来的是
 * `/c/<token>/u/anthropic/v1/messages`，**同时**还带着 `X-Abx-Cell` 头。
 * 如果「头优先」只体现在选哪个令牌上、而不剥前缀，这条完全正常的请求
 * 就会因为路径不以 `/u/` 开头被判成「不知道要转发到哪儿」——
 * 也就是两个机制都开着时反而全盘不可用。
 *
 * 剥前缀跟鉴权无关，所以不需要看 `allowInPath`：它是「把承载令牌的那一段从路径上拿掉」，
 * 拿掉之后要不要放行仍然由令牌比对决定。配置里关掉路径前缀时，前缀本来也不会出现在
 * 生成的 URL 里，这里只是顺手处理掉手写的那些。
 */
/** `extractCellToken` 的输入：只看这两样，别的都不需要。 */
export interface CellTokenInput {
  readonly pathname: string
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

/** 是否接受把令牌写在路径前缀里（`/c/<token>/...`）。 */
export interface CellTokenOptions {
  readonly allowInPath: boolean
}

export function extractCellToken(input: CellTokenInput, options: CellTokenOptions): CellTokenExtraction {
  const fromHeader = firstHeaderValue(input.headers[CELL_TOKEN_HEADER])
  if (fromHeader !== undefined && fromHeader !== '') {
    return { token: fromHeader, source: 'header', pathname: stripCellPathPrefix(input.pathname) }
  }

  if (!options.allowInPath) return { token: null, source: null, pathname: input.pathname }
  if (!input.pathname.startsWith(CELL_PATH_PREFIX)) {
    return { token: null, source: null, pathname: input.pathname }
  }

  const rest = input.pathname.slice(CELL_PATH_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return { token: rest === '' ? null : rest, source: 'path', pathname: '/' }

  const token = rest.slice(0, slash)
  if (token === '') return { token: null, source: null, pathname: input.pathname }
  return { token, source: 'path', pathname: rest.slice(slash) }
}

/** 把 `/c/<token>` 那一段拿掉；没有这一段就原样返回。 */
function stripCellPathPrefix(pathname: string): string {
  if (!pathname.startsWith(CELL_PATH_PREFIX)) return pathname
  const rest = pathname.slice(CELL_PATH_PREFIX.length)
  const slash = rest.indexOf('/')
  // `/c/<token>` 后面什么都没有：剥完就是根路径。
  if (slash === -1) return '/'
  return rest.slice(slash)
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value[0]
}
