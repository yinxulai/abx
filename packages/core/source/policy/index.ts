/**
 * `@abx/policy` 的公开面。
 *
 * 域名语法的解析与校验住在 `@abx/contracts`（那是「配置允许写什么」），
 * 这里再导出一次，让调用方只需要认识 policy 一个包。
 */

export { isSubdomainOf, matchesAnyPattern, matchesDomainPattern, matchesParsedPattern } from './domain-match'
export { buildUpstreamIndex, evaluateEgress, upstreamForHost } from './egress'
export type { EgressDecision } from './egress'

export { isValidDomainPattern, normalizeHost, parseDomainPattern } from '@abx/contracts'
export type { DomainPattern, ParseDomainPatternResult } from '@abx/contracts'
