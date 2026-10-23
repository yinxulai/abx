/**
 * 读配置：JSON 文件 → 环境变量展开 → 形状校验 → 交叉校验。
 *
 * 顺序是有讲究的：
 *
 *   1. **先扫明文密钥，再展开环境变量。** 反过来的话，一个合法的
 *      `"auditPath": "${HOME}/audit.jsonl"` 会被展开成一个真实路径，
 *      而真实路径里但凡长得像凭据就会被误判。要检查的是「进仓库的那份文件」，
 *      所以必须在它还是原文的时候检查。
 *   2. 展开完再校验形状。`"hostPort": "${ABX_PORT}"` 展开前是字符串，
 *      展开后才是数字，形状校验放在前面会把所有带引用的配置全判错。
 *   3. 交叉校验放最后：它要同时看到 upstreams 和 egress 才能发现「上游没进白名单」
 *      这种配置错误。
 */

import { findInlineSecrets } from './inline-secret-guard'
import { expandEnvTree } from './expand-env'
import { parseDomainPattern } from './domain-pattern'
import { ConfigError, IssueCollector, type ConfigIssue } from './issues'
import { readBoolean, readInt, readNumber, readObject, readOptionalString, readString } from './readers'
import type {
  AbxConfig,
  BrokerConfig,
  EgressRule,
  ResourceLimits,
  SandboxBackendId,
  SessionConfig,
  Upstream,
} from './config'

export const DEFAULT_CONFIG: AbxConfig = {
  broker: {
    // 宿主面不校验令牌，所以只能待在回环上，这个值不给配。
    host: '127.0.0.1',
    hostPort: 8788,
    // docker 网桥的网关地址。local 后端下由 CLI 覆盖成 127.0.0.1。
    cellHost: '172.17.0.1',
    cellPort: 8789,
    cellTokenEnv: 'ABX_CELL_TOKEN',
    allowCellTokenInPath: true,
    auditPath: './abx-audit.jsonl',
    requestTimeoutMs: 120_000,
  },
  egress: [],
  upstreams: [],
  session: {
    // 默认必须是 docker。默认 local 等于默认没有沙箱，
    // 而「默认不安全」是这类工具最不该有的性质。
    backend: 'docker',
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    workdir: '/workspace',
    limits: { memory: '2g', pids: 256, cpus: 2 },
    tmpfsSizeMb: 64,
  },
}

export type LoadConfigResult =
  | { readonly ok: true; readonly config: AbxConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] }

export interface ParseConfigOptions {
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * 从一棵已经 `JSON.parse` 过的树里读出配置。
 *
 * 单独暴露出来是为了让测试可以直接喂对象，不必往磁盘上写临时文件。
 */
export function parseConfig(raw: unknown, options: ParseConfigOptions): LoadConfigResult {
  // 步骤 1：明文密钥。命中就直接返回，不再往下走——继续校验只会用一堆
  // 「缺字段」的报错盖住真正要紧的那一条。
  const inlineSecrets = findInlineSecrets(raw)
  if (inlineSecrets.length > 0) {
    return {
      ok: false,
      issues: inlineSecrets.map((finding) => ({
        path: finding.path,
        message: `配置里不允许出现明文密钥（${finding.detail}）。改成 \`secretEnv\`（环境变量名）或 \`secretFile\`（文件路径）。`,
      })),
    }
  }

  // 步骤 2：环境变量引用。
  const expanded = expandEnvTree(raw, options.env)
  const issues = new IssueCollector()
  for (const name of expanded.missing) {
    issues.add('<root>', `配置引用了环境变量 \${${name}}，但它没有值，也没有写 \${${name}:-默认值}`)
  }

  const root = readObject(issues, '', expanded.value)
  if (root === null) return { ok: false, issues: issues.issues }

  // 步骤 3：形状。
  const broker = parseBroker(issues, root['broker'])
  const upstreams = parseUpstreams(issues, root['upstreams'])
  const egress = parseEgress(issues, root['egress'])
  const session = parseSession(issues, root['session'])

  // 步骤 4：交叉校验。任何一段没解析出来就跳过——在残缺的数据上再报一次错，
  // 只会产生一堆由前一个错派生出来的噪音。
  if (upstreams !== null && egress !== null) crossCheck(issues, upstreams, egress)

  if (!issues.ok) return { ok: false, issues: issues.issues }

  return { ok: true, config: { broker, upstreams, egress, session } as AbxConfig }
}

export interface LoadConfigOptions extends ParseConfigOptions {
  readonly filePath: string
  /** 注入读文件，测试里就不用碰磁盘。 */
  readonly readFile: (path: string) => string
}

export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  let text: string
  try {
    text = options.readFile(options.filePath)
  } catch (error) {
    return { ok: false, issues: [{ path: options.filePath, message: `读不到配置文件：${describeError(error)}` }] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, issues: [{ path: options.filePath, message: `不是合法的 JSON：${describeError(error)}` }] }
  }

  return parseConfig(raw, options)
}

/** 加载失败就抛。给 CLI 用：命令行工具没有「继续跑一半」这个选项。 */
export function loadConfigOrThrow(options: LoadConfigOptions): AbxConfig {
  const result = loadConfig(options)
  if (!result.ok) throw new ConfigError(result.issues)
  return result.config
}

function parseBroker(issues: IssueCollector, value: unknown): BrokerConfig | null {
  const defaults = DEFAULT_CONFIG.broker
  if (value === undefined) return defaults

  const object = readObject(issues, 'broker', value)
  if (object === null) return null

  const hostPort = readInt(issues, 'broker.hostPort', object['hostPort'] ?? defaults.hostPort, { min: 1, max: 65535 })
  const cellPort = readInt(issues, 'broker.cellPort', object['cellPort'] ?? defaults.cellPort, { min: 1, max: 65535 })
  const cellHost = readString(issues, 'broker.cellHost', object['cellHost'] ?? defaults.cellHost)
  const cellTokenEnv = readString(issues, 'broker.cellTokenEnv', object['cellTokenEnv'] ?? defaults.cellTokenEnv, {
    pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
    patternHint: '要写环境变量名，不是令牌本身',
  })
  const allowCellTokenInPath = readBoolean(
    issues,
    'broker.allowCellTokenInPath',
    object['allowCellTokenInPath'] ?? defaults.allowCellTokenInPath,
  )
  const auditPath = readString(issues, 'broker.auditPath', object['auditPath'] ?? defaults.auditPath)
  const requestTimeoutMs = readInt(
    issues,
    'broker.requestTimeoutMs',
    object['requestTimeoutMs'] ?? defaults.requestTimeoutMs,
    { min: 1 },
  )

  // 两个面绑同一个地址端口，第二个 listen 会 EADDRINUSE，而报错只会在启动时才出现。
  if (hostPort !== null && cellPort !== null && hostPort === cellPort) {
    issues.add('broker.cellPort', `不能和 broker.hostPort 相同（都是 ${hostPort}）`)
  }

  if (
    hostPort === null ||
    cellPort === null ||
    cellHost === null ||
    cellTokenEnv === null ||
    allowCellTokenInPath === null ||
    auditPath === null ||
    requestTimeoutMs === null
  ) {
    return null
  }

  return {
    host: defaults.host,
    hostPort,
    cellHost,
    cellPort,
    cellTokenEnv,
    allowCellTokenInPath,
    auditPath,
    requestTimeoutMs,
  }
}

function parseUpstreams(issues: IssueCollector, value: unknown): Upstream[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    issues.add('upstreams', '期望一个数组')
    return null
  }

  const output: Upstream[] = []
  value.forEach((item, index) => {
    const path = `upstreams[${index}]`
    const object = readObject(issues, path, item)
    if (object === null) return

    const id = readString(issues, `${path}.id`, object['id'], {
      pattern: /^[a-z0-9][a-z0-9-]*$/,
      patternHint: '只能用小写字母、数字和连字符，且以字母或数字开头（它会出现 URL 里）',
    })
    const baseUrl = readString(issues, `${path}.baseUrl`, object['baseUrl'])
    const authHeader = readString(issues, `${path}.authHeader`, object['authHeader'], {
      pattern: /^[A-Za-z0-9-]+$/,
      patternHint: '要写 HTTP 头的名字，例如 authorization',
    })
    const authScheme = readOptionalString(issues, `${path}.authScheme`, object['authScheme'])
    const secretEnv = readOptionalString(issues, `${path}.secretEnv`, object['secretEnv'], {
      pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
      patternHint: '要写环境变量名，不是密钥本身',
    })
    const secretFile = readOptionalString(issues, `${path}.secretFile`, object['secretFile'])

    if (baseUrl !== null) {
      const parsed = tryParseUrl(baseUrl)
      if (parsed === null) {
        issues.add(`${path}.baseUrl`, `不是合法的 URL：${JSON.stringify(baseUrl)}`)
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.add(`${path}.baseUrl`, `只支持 http / https，实际是 ${parsed.protocol}`)
      }
    }

    // 凭据来源必须恰好一个。两个都写，读代码的人无法判断哪个生效；
    // 一个都不写，这个上游转发出去就是匿名请求，多半不是本意。
    if (secretEnv === null && secretFile === null) {
      issues.add(path, '必须提供 `secretEnv`（环境变量名）或 `secretFile`（文件路径）之一')
    }
    if (secretEnv !== null && secretFile !== null) {
      issues.add(path, '`secretEnv` 和 `secretFile` 只能写一个')
    }

    if (id === null || baseUrl === null || authHeader === null) return
    output.push({ id, baseUrl, authHeader, authScheme, secretEnv, secretFile })
  })

  const duplicated = findDuplicates(output.map((upstream) => upstream.id))
  for (const id of duplicated) issues.add('upstreams', `上游 id 重复：${id}`)

  return output
}

/**
 * 读 `egress` 段。
 *
 * 白名单挂在 `egress.allow` 下而不是直接放在 `egress`，是为了给以后留位置：
 * `egress` 迟早要有 `deny`、`proxy`、`maxBodyBytes` 这些兄弟字段，而
 * 「egress 本身就是一个数组」这个形状一旦定下来就改不动了。
 */
function parseEgress(issues: IssueCollector, value: unknown): EgressRule[] | null {
  if (value === undefined) {
    // 不写就是空名单。空名单的语义是全部拒绝，不是全部放行——
    // 这条默认值本身就是一道防线，值得写一行注释钉住。
    return []
  }

  const section = readObject(issues, 'egress', value)
  if (section === null) return null

  const allow = section['allow']
  if (allow === undefined) return []
  if (!Array.isArray(allow)) {
    issues.add('egress.allow', '期望一个数组')
    return null
  }

  const output: EgressRule[] = []
  allow.forEach((item, index) => {
    const path = `egress.allow[${index}]`

    // 两种写法：`"api.example.com"` 和 `{ "pattern": "...", "upstreamId": "..." }`。
    // 前者够用且短，后者才需要绑凭据。
    if (typeof item === 'string') {
      const pattern = validatePattern(issues, path, item)
      if (pattern !== null) output.push({ pattern, upstreamId: null })
      return
    }

    const object = readObject(issues, path, item)
    if (object === null) return
    const rawPattern = readString(issues, `${path}.pattern`, object['pattern'])
    const upstreamId = readOptionalString(issues, `${path}.upstreamId`, object['upstreamId'])
    const pattern = rawPattern === null ? null : validatePattern(issues, `${path}.pattern`, rawPattern)
    if (pattern === null) return
    output.push({ pattern, upstreamId })
  })

  const duplicated = findDuplicates(output.map((rule) => rule.pattern))
  for (const pattern of duplicated) issues.add('egress.allow', `域名重复：${pattern}`)

  return output
}

function validatePattern(issues: IssueCollector, path: string, raw: string): string | null {
  const result = parseDomainPattern(raw)
  if (!result.ok) {
    issues.add(path, result.reason)
    return null
  }
  // 存归一化之后的形式：匹配时不必再解析一次，也避免 `EXAMPLE.com` 和
  // `example.com` 在配置里看起来是两条规则。
  return raw.trim().toLowerCase()
}

function parseSession(issues: IssueCollector, value: unknown): SessionConfig | null {
  const defaults = DEFAULT_CONFIG.session
  if (value === undefined) return defaults

  const object = readObject(issues, 'session', value)
  if (object === null) return null

  const backend = parseBackend(issues, object['backend'] ?? defaults.backend)
  const image = readString(issues, 'session.image', object['image'] ?? defaults.image)
  const user = readString(issues, 'session.user', object['user'] ?? defaults.user)
  const network = readString(issues, 'session.network', object['network'] ?? defaults.network)
  const workdir = readString(issues, 'session.workdir', object['workdir'] ?? defaults.workdir, {
    pattern: /^\//,
    patternHint: '必须是舱内的绝对路径，例如 /workspace',
  })
  const tmpfsSizeMb = readInt(issues, 'session.tmpfsSizeMb', object['tmpfsSizeMb'] ?? defaults.tmpfsSizeMb, {
    min: 1,
  })
  const limits = parseLimits(issues, object['limits'])

  if (
    backend === null ||
    image === null ||
    user === null ||
    network === null ||
    workdir === null ||
    tmpfsSizeMb === null ||
    limits === null
  ) {
    return null
  }

  return { backend, image, user, network, workdir, limits, tmpfsSizeMb }
}

function parseBackend(issues: IssueCollector, value: unknown): SandboxBackendId | null {
  if (value === 'docker' || value === 'local') return value
  issues.add('session.backend', `只支持 "docker" 或 "local"，实际是 ${JSON.stringify(value)}`)
  return null
}

function parseLimits(issues: IssueCollector, value: unknown): ResourceLimits | null {
  const defaults = DEFAULT_CONFIG.session.limits
  if (value === undefined) return defaults

  const object = readObject(issues, 'session.limits', value)
  if (object === null) return null

  const memory = readString(issues, 'session.limits.memory', object['memory'] ?? defaults.memory, {
    pattern: /^\d+[bkmgBKMG]?$/,
    patternHint: 'docker 的写法，例如 2g / 512m',
  })
  const pids = readInt(issues, 'session.limits.pids', object['pids'] ?? defaults.pids, { min: 1 })
  const cpus = readNumber(issues, 'session.limits.cpus', object['cpus'] ?? defaults.cpus, { min: 0.01 })

  if (memory === null || pids === null || cpus === null) return null
  return { memory, pids, cpus }
}

/**
 * 交叉校验。
 *
 * 最要紧的一条是「上游没进白名单」：白名单对**所有**请求生效，包括 `/u/<id>/...`
 * 这条看起来「已经配置过」的路由。少了这条检查，用户会看到一个配置齐全的上游
 * 每次请求都 403，而报错信息里只有域名，很难联想到是 egress 少了那一行。
 */
function crossCheck(issues: IssueCollector, upstreams: readonly Upstream[], egress: readonly EgressRule[]): void {
  const upstreamIds = new Set(upstreams.map((upstream) => upstream.id))

  egress.forEach((rule, index) => {
    if (rule.upstreamId !== null && !upstreamIds.has(rule.upstreamId)) {
      issues.add(`egress.allow[${index}].upstreamId`, `没有 id 为 ${JSON.stringify(rule.upstreamId)} 的上游`)
    }
  })

  upstreams.forEach((upstream, index) => {
    const host = tryParseUrl(upstream.baseUrl)?.hostname
    if (host === undefined) return
    const covered = egress.some((rule) => matchesPatternForValidation(host, rule.pattern))
    if (!covered) {
      issues.add(
        `upstreams[${index}].baseUrl`,
        `域名 ${host} 不在 egress.allow 里，这个上游的请求会被全部 403。` +
          `要么在 egress.allow 里加上 "${host}"，要么去掉这个上游。`,
      )
    }
  })
}

/** 只为校验服务的一次性匹配；正式匹配在 `@abx/policy`。 */
function matchesPatternForValidation(host: string, pattern: string): boolean {
  const parsed = parseDomainPattern(pattern)
  if (!parsed.ok) return false
  if (parsed.pattern.kind === 'exact') return host === parsed.pattern.host
  if (parsed.pattern.kind === 'subdomains') return host.endsWith(`.${parsed.pattern.host}`)
  return host === parsed.pattern.host || host.endsWith(`.${parsed.pattern.host}`)
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value)
    seen.add(value)
  }
  return [...duplicated]
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把白名单里的通配项列出来，doctor 用它提醒「白名单是不是写宽了」。 */
export function listWildcardPatterns(egress: readonly EgressRule[]): readonly string[] {
  return egress
    .filter((rule) => rule.pattern.startsWith('*') || rule.pattern.startsWith('.'))
    .map((rule) => rule.pattern)
}
