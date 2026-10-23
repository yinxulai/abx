/**
 * 配置文件里的环境变量引用。
 *
 * 配置文件要进仓库，所以端口、路径这类「每台机器不一样、但又不是秘密」的值写成
 * `${ABX_HOST_PORT}` 比写死好。支持 `${VAR:-fallback}` 给默认值。
 *
 * 只做一层展开，不递归：`${A}` 展开出来的 `${B}` 不会再被当成引用。递归展开意味着
 * 一个环境变量的值可以拼出另一个变量的名字，配置的可读性会从这里开始塌掉。
 */

/** 匹配 `${VAR}` 或 `${VAR:-fallback}`；变量名按 POSIX 的规矩来。 */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

export interface ExpandResult {
  readonly value: string
  /** 没有默认值、环境里也没有的变量名。 */
  readonly missing: readonly string[]
}

export function expandEnvRefs(input: string, env: Readonly<Record<string, string | undefined>>): ExpandResult {
  const missing: string[] = []
  const value = input.replace(REFERENCE_PATTERN, (match, name: string, fallback: string | undefined) => {
    const fromEnv = env[name]
    if (fromEnv !== undefined) return fromEnv
    if (fallback !== undefined) return fallback
    missing.push(name)
    // 保留原文，让报错里能看到是哪一处没展开，而不是一个空字符串。
    return match
  })
  return { value, missing }
}

/**
 * 注释键：`$comment` 里的内容是写给读配置的人看的，不是配置。
 *
 * 必须显式跳过，而且这个跳过是**功能正确性**的一部分，不是洁癖：
 * 项目自己的 `abx.config.json` 里就有一行注释在解释语法，写的是
 * 「可以用 ${VAR} 或 ${VAR:-默认值} 引用环境变量」。如果连注释也展开，
 * 那句说明里的 `${VAR}` 会被当成一个真的引用，于是**一份完全正确的配置**
 * 会在启动时报「环境变量 VAR 没有值」。同理，注释里举例说明什么是密钥形状时
 * 也会被明文密钥扫描器命中。
 */
function isCommentKey(key: string): boolean {
  return key.startsWith('$')
}

/**
 * 递归展开一棵 JSON 树里的所有字符串。
 *
 * 返回整棵树而不是逐字段处理，是因为配置的形状会变，而「哪些字段允许引用环境变量」
 * 这种白名单迟早会漏掉新加的字段——漏掉的表现是引用被当成字面量静默留在配置里。
 */
export interface ExpandTreeResult {
  readonly value: unknown
  readonly missing: readonly string[]
}

export function expandEnvTree(input: unknown, env: Readonly<Record<string, string | undefined>>): ExpandTreeResult {
  const missing = new Set<string>()

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = expandEnvRefs(node, env)
      for (const name of result.missing) missing.add(name)
      return result.value
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        if (isCommentKey(key)) continue
        output[key] = walk(child)
      }
      return output
    }
    return node
  }

  return { value: walk(input), missing: [...missing] }
}
