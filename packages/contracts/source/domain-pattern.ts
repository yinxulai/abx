/**
 * 出口白名单的域名语法。
 *
 * 放在 contracts 而不是 policy，是因为它回答的是「配置里这个字段允许写什么」——
 * 是配置形状的一部分，跟「怎么匹配」是两件事。policy 负责匹配，并把这几个函数
 * 原样再导出一遍，让用 policy 的人只需要认识一个包。
 *
 * 三种模式（与需求一致）：
 *   `api.example.com`   精确：只匹配它自己
 *   `*.example.com`     通配：只匹配子域，不含 `example.com` 本身
 *   `.example.com`      域：`example.com` 本身 + 全部子域
 *
 * 故意不支持裸 `*`。写了 `*` 的人想要的是「全部放行」，而它和白名单这个机制本身
 * 是冲突的——真有这个需要，应该在配置评审里被看见，而不是被一个星号悄悄带过。
 */

export type DomainPattern =
  /** `api.example.com` */
  | { readonly kind: 'exact'; readonly host: string }
  /** `*.example.com`：子域，不含自身。 */
  | { readonly kind: 'subdomains'; readonly host: string }
  /** `.example.com`：自身 + 子域。 */
  | { readonly kind: 'domain'; readonly host: string }

export type ParseDomainPatternResult =
  | { readonly ok: true; readonly pattern: DomainPattern }
  | { readonly ok: false; readonly reason: string }

const MAX_HOSTNAME_LENGTH = 253
const MAX_LABEL_LENGTH = 63
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * 把请求头里的 host 归一成可比对的形式。
 *
 * 三件事：小写、去端口、去末尾的点。末尾的点是 DNS 的根标签（`example.com.` 与
 * `example.com` 等价），不去掉的话 `Host: example.com.` 就能绕开白名单——
 * 这是白名单实现里最常见的一个洞。
 *
 * IPv6 字面量在 `Host` 头里一定带方括号（`[::1]:8080`），先剥括号再按端口切。
 */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase()

  if (host.startsWith('[')) {
    const closing = host.indexOf(']')
    if (closing !== -1) return host.slice(1, closing)
    return host.slice(1)
  }

  // 裸 IPv6（多个冒号）没有端口可言，原样返回。
  const firstColon = host.indexOf(':')
  if (firstColon !== -1 && host.indexOf(':', firstColon + 1) === -1) {
    host = host.slice(0, firstColon)
  }

  // 只有一个末尾点也去掉：`example.com..` 这种不是合法域名，下面还会再拦一次。
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

export function isIpv4Literal(host: string): boolean {
  if (!IPV4_PATTERN.test(host)) return false
  return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
}

/** 只认「点分十进制 IPv4」和「小写字母数字连字符组成的域名」。 */
export function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false
  if (isIpv4Literal(host)) return true
  // IPv6 字面量：交给 URL 解析器去判断太绕，这里只做「含冒号且只含十六进制和冒号」的粗判。
  if (host.includes(':')) return /^[0-9a-f:]+$/.test(host)
  return host.split('.').every((label) => label.length > 0 && label.length <= MAX_LABEL_LENGTH && LABEL_PATTERN.test(label))
}

export function parseDomainPattern(input: string): ParseDomainPatternResult {
  const raw = input.trim().toLowerCase()

  if (raw.length === 0) return { ok: false, reason: '不能为空' }
  if (raw === '*') {
    return { ok: false, reason: '不支持裸 `*`：需要放行全部域名时请逐条列出，白名单不留后门' }
  }
  if (raw.includes('://') || raw.includes('/')) {
    return { ok: false, reason: '只写域名，不要带协议或路径' }
  }

  if (raw.startsWith('*.')) {
    const host = normalizeHost(raw.slice(2))
    const invalid = validateWildcardBase(host, '*.')
    if (invalid !== null) return { ok: false, reason: invalid }
    return { ok: true, pattern: { kind: 'subdomains', host } }
  }

  if (raw.startsWith('.')) {
    const host = normalizeHost(raw.slice(1))
    const invalid = validateWildcardBase(host, '.')
    if (invalid !== null) return { ok: false, reason: invalid }
    return { ok: true, pattern: { kind: 'domain', host } }
  }

  const host = normalizeHost(raw)
  if (!isValidHostname(host)) return { ok: false, reason: `不是合法的域名或 IP：${JSON.stringify(input)}` }
  return { ok: true, pattern: { kind: 'exact', host } }
}

/**
 * 通配模式的基域名要求至少两级。
 *
 * `*.com` / `.io` 这种写法在语法上完全成立，但语义上等于「放行整个顶级域」——
 * 写的人多半只是想省事，而后果是白名单在这一整片域名上失效。拦掉。
 * 同时也不接受把通配写在中间（`api.*.com`）：没有实现，就不假装支持。
 */
function validateWildcardBase(host: string, prefix: string): string | null {
  if (host.length === 0) return `\`${prefix}\` 后面要跟域名`
  if (host.includes('*')) return '通配符只能出现在最前面'
  if (!isValidHostname(host)) return `不是合法的域名：${JSON.stringify(host)}`
  if (!host.includes('.') && !host.includes(':')) {
    return `\`${prefix}${host}\` 只覆盖一个顶级域，范围太大；至少要写两级域名`
  }
  return null
}

export function isValidDomainPattern(input: string): boolean {
  return parseDomainPattern(input).ok
}
