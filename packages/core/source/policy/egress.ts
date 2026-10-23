/**
 * 出口裁决：一个目标域名，一份白名单，放行还是拒绝。
 *
 * 默认拒绝是这里唯一的默认值。空名单、解析不出域名、匹配抛错，结果全都是拒绝。
 * 反过来（默认放行、命中规则才拦）在实现上更省事，但那等于把「白名单」做成了
 * 「黑名单」，而黑名单的失效方式是静默的。
 */

import { normalizeHost, type EgressRule, type Upstream, type UpstreamIndex } from '@abx/contracts'
import { matchesDomainPattern } from './domain-match'

export type EgressDecision =
  | {
      readonly allowed: true
      /** 命中的那条规则的模式原文，写进审计用。 */
      readonly pattern: string
      /** 命中的规则绑了哪个上游；`null` 表示只放行、不注入凭据。 */
      readonly upstreamId: string | null
    }
  | { readonly allowed: false; readonly reason: 'not-allowlisted'; readonly host: string }

/**
 * 按配置顺序取**第一条**命中的规则。
 *
 * 「第一条」而不是「最精确的一条」是刻意的：规则顺序就是文件里的顺序，
 * 用户能一眼看出哪条先生效。换成「最精确优先」的话，给某条规则加上
 * 一个例外就得去理解一套优先级算法，而这套算法的实现者通常不是读它的那个人。
 */
export function evaluateEgress(host: string, allowlist: readonly EgressRule[]): EgressDecision {
  const normalized = normalizeHost(host)
  if (normalized === '') return { allowed: false, reason: 'not-allowlisted', host: normalized }

  for (const rule of allowlist) {
    if (matchesDomainPattern(normalized, rule.pattern)) {
      return { allowed: true, pattern: rule.pattern, upstreamId: rule.upstreamId }
    }
  }

  return { allowed: false, reason: 'not-allowlisted', host: normalized }
}

/**
 * baseUrl 的 host → 上游。
 *
 * 直通模式（放行了域名、但请求没走 `/u/<id>/`）靠它决定「要不要顺手把凭据换掉」：
 * 目标域名正好是某个已配置上游的域名时，就换；否则这个域名我们没有对应的密钥，
 * 只能把舱内的占位符剥掉再转发。
 */
export function buildUpstreamIndex(upstreams: readonly Upstream[]): UpstreamIndex {
  const byHost = new Map<string, Upstream>()
  const byId = new Map<string, Upstream>()

  for (const upstream of upstreams) {
    byId.set(upstream.id, upstream)
    const host = hostOfBaseUrl(upstream.baseUrl)
    // 同一个 host 配了两个上游时保留先出现的那个：配置校验已经拦了 id 重复，
    // 但没拦 baseUrl 重复，而这里需要一个确定的答案。
    if (host !== null && !byHost.has(host)) byHost.set(host, upstream)
  }

  return { byHost, byId }
}

export function upstreamForHost(index: UpstreamIndex, host: string): Upstream | null {
  return index.byHost.get(normalizeHost(host)) ?? null
}

function hostOfBaseUrl(baseUrl: string): string | null {
  try {
    return normalizeHost(new URL(baseUrl).hostname)
  } catch {
    return null
  }
}
