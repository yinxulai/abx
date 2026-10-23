/**
 * 域名匹配。整个包的核心就是这一个文件里的二十行。
 *
 * 每一个判断都只做「字符串比较」，不做任何模糊匹配、不做后缀包含、不碰正则回溯。
 * 白名单这种东西，实现越朴素越难写错；写错一次就是全放行或者全拒绝，
 * 两种都不会有人在 review 里看出来。
 */

import { normalizeHost, parseDomainPattern, type DomainPattern } from '@abx/contracts'

/**
 * `host` 是不是 `parent` 的子域。
 *
 * 自身不算子域——`example.com` 不是 `example.com` 的子域。这条区分是
 * `*.example.com` 和 `.example.com` 唯一的差别所在，也是最容易写错的地方。
 *
 * 比较时带上那个点，否则 `notexample.com` 会被判成 `example.com` 的子域。
 */
export function isSubdomainOf(host: string, parent: string): boolean {
  if (host === parent) return false
  return host.endsWith(`.${parent}`)
}

/** 拿一个已经解析好的模式去匹配。`host` 必须是 `normalizeHost` 过的。 */
export function matchesParsedPattern(host: string, pattern: DomainPattern): boolean {
  switch (pattern.kind) {
    case 'exact':
      return host === pattern.host
    case 'subdomains':
      return isSubdomainOf(host, pattern.host)
    case 'domain':
      return host === pattern.host || isSubdomainOf(host, pattern.host)
  }
  // `DomainPattern` 只有三种 kind，走到这里说明配置里出现了未知的 kind。
  // 按「默认拒绝」处理而不是抛错：白名单的失败方向必须是关，不是开。
  return false
}

/**
 * 拿一个配置里写的模式字符串去匹配。
 *
 * `host` 允许是原始的 `Host` 头（带端口、带大小写、带末尾点），这里会先归一化。
 * 模式解析失败时返回 `false`：配置写错了应该是「谁都进不来」，而不是「谁都能进来」。
 */
export function matchesDomainPattern(host: string, pattern: string): boolean {
  const parsed = parseDomainPattern(pattern)
  if (!parsed.ok) return false
  return matchesParsedPattern(normalizeHost(host), parsed.pattern)
}

export function matchesAnyPattern(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesDomainPattern(host, pattern))
}
