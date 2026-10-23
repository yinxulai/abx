/**
 * 「配置里不许出现明文密钥」这条规则的可执行版本。
 *
 * 光写在文档里没用：抄一份配置、把 `secretEnv` 改成 `secret` 再把 key 粘进去，
 * 是所有人都干过的事，而且干完没有任何反馈——直到某个 commit 把它推到远端。
 * 所以加载配置时先把整棵树扫一遍，命中就拒绝启动。
 *
 * 判据有两类，宁可误报也不能漏报：
 *   1. 叶子键名本身就是「这是一个秘密」的意思，且没有用 `Env` / `File` / `Path` /
 *      `Name` / `Header` / `Scheme` 这类后缀说明它其实是个引用；
 *   2. 值长得像已知的凭据（`sk-ant-` / `ghp_` / `AKIA...` / PEM 私钥 …），
 *      不管键名叫什么。
 *
 * 第 2 条会扫到 `secretEnv: "sk-ant-xxx"` 这种「键名合法、值是真钥匙」的写法——
 * 那正是最危险的一种，因为读配置的人会以为它是个变量名。
 */

export type InlineSecretReason = 'secret-shaped-key' | 'secret-shaped-value'

export interface InlineSecretFinding {
  /** 出问题的位置，例如 `upstreams[0].secret`。 */
  readonly path: string
  readonly reason: InlineSecretReason
  /** 说明为什么判定成秘密；**不含值本身**，否则报错信息自己就成了泄漏渠道。 */
  readonly detail: string
}

/**
 * 键名里出现这些词就认为它在说「我是秘密」。
 *
 * 比较时先把键名归一化（小写、去掉 `_` 和 `-`），这样 `api_key` / `apiKey` /
 * `API-KEY` 是同一条规则。
 */
const SECRET_KEY_WORDS = [
  'secret',
  'token',
  'password',
  'passwd',
  'apikey',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
]

/**
 * 有了这些后缀，键名就不再是「秘密本身」，而是「秘密在哪」。
 *
 * `secretEnv` 指向变量名、`secretFile` 指向文件路径、`authHeader` 指的是头的名字、
 * `authScheme` 指的是 `Bearer` 这种方案名——四个都不是秘密。
 */
const REFERENCE_SUFFIXES = ['env', 'file', 'path', 'name', 'header', 'scheme', 'ref', 'url']

/** 已知凭据的字面形状。命中即拒绝，不看键名。 */
const SECRET_VALUE_PATTERNS: readonly { readonly detail: string; readonly pattern: RegExp }[] = [
  { detail: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { detail: 'OpenAI 风格的 API key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { detail: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { detail: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { detail: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { detail: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { detail: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { detail: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { detail: 'PEM 私钥', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '')
}

function looksLikeSecretKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (REFERENCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false
  return SECRET_KEY_WORDS.some((word) => normalized.includes(word))
}

function matchSecretValue(value: string): string | null {
  for (const { detail, pattern } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return detail
  }
  return null
}

/**
 * 扫描一棵已经解析好的配置树。
 *
 * 空字符串不算：`"secret": ""` 是「还没填」，不是「填了个秘密」——把它也拦下来，
 * 只会让人学会在配置里绕开这个检查。
 */
export function findInlineSecrets(root: unknown): readonly InlineSecretFinding[] {
  const findings: InlineSecretFinding[] = []

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      const detail = matchSecretValue(node)
      if (detail !== null) findings.push({ path, reason: 'secret-shaped-value', detail })
      return
    }

    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }

    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        // `$comment` 是写给人看的说明，不是配置。扫它没有意义，但它会误伤：
        // 一段「别在这里写 sk-ant-xxxx」的注释会被值扫描器当成真的密钥。
        if (key.startsWith('$')) continue
        const childPath = path === '' ? key : `${path}.${key}`
        // 先查键名：`{"secret": "..."}` 里的值未必长得像已知凭据，
        // 但键名已经说明了作者的意图。
        if (typeof child === 'string' && child !== '' && looksLikeSecretKey(key)) {
          findings.push({
            path: childPath,
            reason: 'secret-shaped-key',
            detail: '键名表明这里应当放引用（环境变量名或文件路径），而不是值',
          })
        }
        walk(child, childPath)
      }
    }
  }

  walk(root, '')
  return findings
}
