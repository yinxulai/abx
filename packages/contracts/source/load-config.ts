/**
 * 读配置：JSON 文件 → 环境变量展开 → schema 校验 → 交叉校验。
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
 *
 * 形状校验本身在 `schema.ts`（那份 zod schema 是配置的唯一真相），这里只负责
 * 把它接进管线：**一次收集全部问题**，而不是遇到第一个就抛。
 */

import { findInlineSecrets } from './inline-secret-guard'
import { expandEnvTree } from './expand-env'
import { parseDomainPattern } from './domain-pattern'
import { ConfigError, IssueCollector, type ConfigIssue } from './issues'
import { abxConfigSchema, tryParseUrl } from './schema'
import type { AbxConfig, EgressRule, Upstream } from './config'
import type { z } from 'zod'

/**
 * 可运行的最小默认值。
 *
 * 从 schema 自己推出来（`parse({})`），而不是另写一份常量：另写一份就是第二个真相，
 * 「schema 改了这里不改」这种现象迟早会出现。顺带还兼一道自检——默认值要是有哪一项
 * 过不了 schema，import 这个模块就会当场炸，而不是在某个字段上悄悄变成 `undefined`。
 */
export const DEFAULT_CONFIG: AbxConfig = abxConfigSchema.parse({})

export type LoadConfigResult =
  | { readonly ok: true; readonly config: AbxConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] }

export interface ParseConfigOptions {
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * 只取交叉校验要用的那两段。
 *
 * 用 `pick` 而不是另写一个小 schema：规则只有一份，改了那份这里自动跟着改。
 */
const crossCheckSectionsSchema = abxConfigSchema.pick({ upstreams: true, egress: true })

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

  // 步骤 3：形状。schema 默认遇错即抛，而这里要的是一次收齐，所以走 `safeParse`
  // 自己遍历 `error.issues`。
  const parsed = abxConfigSchema.safeParse(expanded.value)

  if (!parsed.success) {
    collectZodIssues(issues, parsed.error)

    // 步骤 4：交叉校验。broker / session 有错不该把「上游没在 egress.allow 里」
    // 这条一起吞掉——恰恰是它解释了「配置看起来齐全、请求却全部 403」。
    // 所以那两段单独再跑一遍：它们各自成立时，交叉校验就有意义。
    const sections = crossCheckSectionsSchema.safeParse(expanded.value)
    if (sections.success) crossCheck(issues, sections.data.upstreams, sections.data.egress)

    return { ok: false, issues: issues.issues }
  }

  crossCheck(issues, parsed.data.upstreams, parsed.data.egress)
  if (!issues.ok) return { ok: false, issues: issues.issues }

  return { ok: true, config: parsed.data }
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

// ---------------------------------------------------------------------------
// zod 的问题 → 配置问题
// ---------------------------------------------------------------------------

/**
 * 把 zod 的问题全部映射成 `ConfigIssue`。
 *
 * 报错的形状（`path` 加 `message`）保持迁移前那一套：`path` 是人手写配置时看到的
 * 位置（`upstreams[0].baseUrl`），`message` 是中文的一句话。`ConfigError` /
 * `renderIssues` 的输出因此一个字都没变。
 */
function collectZodIssues(issues: IssueCollector, error: z.ZodError): void {
  for (const issue of error.issues) {
    for (const mapped of mapIssue(issue, [])) issues.add(mapped.path, mapped.message)
  }
}

function mapIssue(issue: z.core.$ZodIssue, prefix: readonly PropertyKey[]): readonly ConfigIssue[] {
  const path = [...prefix, ...issue.path]

  // `egress.allow` 的每一项都允许「字符串」和「对象」两种写法；两种都没对上时
  // zod 不各报一条，而是把两条分支的报错一起挂在这条 `invalid_union` 上。
  if (issue.code === 'invalid_union') {
    return pickBranch(issue.errors).flatMap((branchIssue) => mapIssue(branchIssue, path))
  }

  return [{ path: renderPath(path), message: issue.message }]
}

/**
 * 从 union 的分支里挑一条来报。
 *
 * 挑**错得更深**的那条：`{ "pattern": 5 }` 走对象分支能报到 `.pattern` 上、
 * 走字符串分支只能报到整项上，前者才指得准。一样深时取前一条——那正是按输入类型
 * 该走的那条（字符串输入对应字符串分支），报出来的也是用户真正需要看的那句话。
 */
function pickBranch(branches: readonly (readonly z.core.$ZodIssue[])[]): readonly z.core.$ZodIssue[] {
  let picked: readonly z.core.$ZodIssue[] = []
  let deepest = -1
  for (const branch of branches) {
    const depth = Math.max(-1, ...branch.map((issue) => issue.path.length))
    if (depth > deepest) {
      deepest = depth
      picked = branch
    }
  }
  return picked
}

/** `['upstreams', 0, 'baseUrl']` → `upstreams[0].baseUrl`，与迁移前的写法一致。 */
function renderPath(path: readonly PropertyKey[]): string {
  let rendered = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`
      continue
    }
    rendered = rendered === '' ? String(segment) : `${rendered}.${String(segment)}`
  }
  return rendered
}

// ---------------------------------------------------------------------------
// 交叉校验
// ---------------------------------------------------------------------------

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把白名单里的通配项列出来，doctor 用它提醒「白名单是不是写宽了」。 */
export function listWildcardPatterns(egress: readonly EgressRule[]): readonly string[] {
  return egress
    .filter((rule) => rule.pattern.startsWith('*') || rule.pattern.startsWith('.'))
    .map((rule) => rule.pattern)
}
