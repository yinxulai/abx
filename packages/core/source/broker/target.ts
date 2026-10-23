/**
 * 「这次请求到底要发到哪儿、带什么凭据」——把决策从 IO 里拆出来。
 *
 * 拆出来是为了能单测：凭据注入和白名单这两件事错了都是安全事故，
 * 而它们的正确与否跟 socket 一点关系都没有。`server.ts` 只负责把这里算出来的
 * 结果发出去。
 */

import type { AbxConfig, EgressRule, Upstream } from '@abx/contracts'
import { evaluateEgress, upstreamForHost, type EgressDecision } from '../policy/index'
import { buildAuthHeaderValue, resolveUpstreamSecret, type SecretDependencies } from './credentials'
import type { BrokerRoute } from './route'

/**
 * 直通模式下要剥掉的「看起来像凭据」的头。
 *
 * 舱内发出来的这些头一律是占位符。没有可注入的真凭据时，它们唯一的作用就是
 * 冒充一个身份——留在请求里比删掉危险得多。
 *
 * 刻意**不含** `cookie`：直通的目标可能是任何域名，把 cookie 一律删掉会静默改变
 * 一些正常应用的行为，而它本身不是这套代理要管的凭据形态。
 */
export const STRIPPED_AUTH_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
]

export interface ResolvedTarget {
  readonly ok: true
  /** 协议 + 主机 + 端口。 */
  readonly origin: URL
  /** 发出去的路径，含查询串。 */
  readonly path: string
  readonly upstream: Upstream | null
  readonly upstreamId: string | null
  readonly targetHost: string
  readonly egress: EgressDecision & { readonly allowed: true }
  /** 要写的认证头。`null` 表示这次不注入（并且要剥掉舱内带来的占位符）。 */
  readonly auth: { readonly header: string; readonly value: string } | null
}

export interface ResolvedFailure {
  readonly ok: false
  readonly status: number
  readonly decision: 'denied-egress' | 'denied-unknown-upstream' | 'credential-missing'
  readonly detail: string
  readonly targetHost: string | null
  readonly upstreamId: string | null
}

export type TargetResolution = ResolvedTarget | ResolvedFailure

export interface ResolveTargetOptions {
  readonly config: AbxConfig
  readonly route: BrokerRoute
  readonly search: string
  readonly secrets: SecretDependencies
  /** 上游 id → 上游；以及 baseUrl host → 上游。 */
  readonly upstreamsById: ReadonlyMap<string, Upstream>
  readonly upstreamIndex: Parameters<typeof upstreamForHost>[0]
}

export function resolveTarget(options: ResolveTargetOptions): TargetResolution {
  const { config, route } = options

  if (route.kind === 'upstream') {
    const upstream = options.upstreamsById.get(route.upstreamId) ?? null
    if (upstream === null) {
      return {
        ok: false,
        status: 404,
        decision: 'denied-unknown-upstream',
        detail: `配置里没有 id 为 ${JSON.stringify(route.upstreamId)} 的上游`,
        targetHost: null,
        upstreamId: route.upstreamId,
      }
    }

    const joined = concatUpstreamPath(upstream.baseUrl, route.path, options.search)
    if (joined === null) {
      return {
        ok: false,
        status: 502,
        decision: 'credential-missing',
        detail: `上游 ${upstream.id} 的 baseUrl 不是合法 URL`,
        targetHost: null,
        upstreamId: upstream.id,
      }
    }

    // 白名单对**所有**请求生效，包括这条「已经在配置里」的上游路由。
    // 少了这一步，白名单就成了摆设——只要给域名配上上游就能绕过去。
    const egress = evaluateEgress(joined.origin.hostname, config.egress)
    if (!egress.allowed) {
      return {
        ok: false,
        status: 403,
        decision: 'denied-egress',
        detail: `${joined.origin.hostname} 不在出口白名单里`,
        targetHost: joined.origin.host,
        upstreamId: upstream.id,
      }
    }

    const credential = injectFor(upstream, options.secrets)
    if (!credential.ok) {
      return {
        ok: false,
        status: 502,
        decision: 'credential-missing',
        detail: credential.detail,
        targetHost: joined.origin.host,
        upstreamId: upstream.id,
      }
    }

    return {
      ok: true,
      origin: joined.origin,
      path: joined.path,
      upstream,
      upstreamId: upstream.id,
      targetHost: joined.origin.host,
      egress,
      auth: credential.auth,
    }
  }

  if (route.kind === 'passthrough') {
    const host = route.target.hostname
    const egress = evaluateEgress(host, config.egress)
    if (!egress.allowed) {
      return {
        ok: false,
        status: 403,
        decision: 'denied-egress',
        detail: `${host} 不在出口白名单里`,
        targetHost: route.target.host,
        upstreamId: null,
      }
    }

    const upstream = pickPassthroughUpstream(egress, host, options.upstreamsById, options.upstreamIndex)
    if (upstream === null) {
      // 放行，但没有对应的密钥可注入：只把舱内带来的占位符剥掉。
      // 这不是错误——白名单里本来就可以有「只放行、不带凭据」的域名。
      return {
        ok: true,
        origin: route.target,
        path: route.path,
        upstream: null,
        upstreamId: null,
        targetHost: route.target.host,
        egress,
        auth: null,
      }
    }

    const credential = injectFor(upstream, options.secrets)
    if (!credential.ok) {
      return {
        ok: false,
        status: 502,
        decision: 'credential-missing',
        detail: credential.detail,
        targetHost: route.target.host,
        upstreamId: upstream.id,
      }
    }

    return {
      ok: true,
      origin: route.target,
      path: route.path,
      upstream,
      upstreamId: upstream.id,
      targetHost: route.target.host,
      egress,
      auth: credential.auth,
    }
  }

  // `health` / `invalid` 在进这个函数之前就该被处理掉。
  return {
    ok: false,
    status: 500,
    decision: 'credential-missing',
    detail: `不该走到这儿：${route.kind}`,
    targetHost: null,
    upstreamId: null,
  }
}

/**
 * 直通模式下注入谁的凭据。
 *
 * 优先用白名单那条规则自己绑的上游（配置里显式写下的意图），
 * 其次才退回到「baseUrl 的 host 恰好等于目标域名」这个推断。
 * 顺序反过来的话，一条 `{ "pattern": ".example.com", "upstreamId": "internal" }`
 * 会被某个恰好也叫 example.com 的上游悄悄顶掉。
 */
type AllowedEgress = Extract<EgressDecision, { readonly allowed: true }>

function pickPassthroughUpstream(egress: AllowedEgress, host: string, upstreamsById: ReadonlyMap<string, Upstream>, upstreamIndex: Parameters<typeof upstreamForHost>[0]): Upstream | null {
  if (egress.upstreamId !== null) {
    return upstreamsById.get(egress.upstreamId) ?? null
  }
  return upstreamForHost(upstreamIndex, host)
}

type InjectResult =
  | { readonly ok: true; readonly auth: { readonly header: string; readonly value: string } }
  | { readonly ok: false; readonly detail: string }

function injectFor(upstream: Upstream, secrets: SecretDependencies): InjectResult {
  const resolution = resolveUpstreamSecret(upstream, secrets)
  if (!resolution.ok) return { ok: false, detail: resolution.detail }

  return {
    ok: true,
    auth: {
      // 头名转小写：Node 的 `req.headers` 全是小写，出站也统一小写，
      // 免得出现两个大小写不同、语义相同的头同时挂在请求上。
      header: upstream.authHeader.toLowerCase(),
      value: buildAuthHeaderValue(upstream.authScheme, resolution.secret),
    },
  }
}

/**
 * `baseUrl + 请求路径`。
 *
 * 用字符串拼而不是 `new URL(path, base)`：后者在 path 以 `/` 开头时会**丢掉**
 * baseUrl 自带的路径前缀（`https://gw.example.com/anthropic` + `/v1/messages`
 * 会变成 `https://gw.example.com/v1/messages`）。需求里写的是「baseUrl + 原路径」，
 * 拼字符串就是字面意思。
 */
export interface ConcatUpstreamPathResult {
  readonly origin: URL
  readonly path: string
}

export function concatUpstreamPath(baseUrl: string, requestPath: string, search: string): ConcatUpstreamPathResult | null {
  let origin: URL
  try {
    origin = new URL(baseUrl)
  } catch {
    return null
  }

  const basePath = origin.pathname.replace(/\/+$/, '')
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  return { origin, path: `${basePath}${suffix}${search}` }
}

/** 白名单规则里绑了上游的那些，doctor 用它提示「这条规则会注入凭据」。 */
export function describeCredentialBinding(egress: readonly EgressRule[]): readonly string[] {
  return egress
    .filter((rule) => rule.upstreamId !== null)
    .map((rule) => `${rule.pattern} → ${rule.upstreamId ?? ''}`)
}
