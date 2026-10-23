/**
 * 从 `unknown` 里读出有类型的值。
 *
 * 手写而不是引 zod：这个项目的运行期依赖要尽量是零，而这里需要的检查一共就这几种。
 * 每个读取器失败时往收集器里记一条并返回 `null`，调用方继续往下读——
 * 于是一次就能报出全部问题。
 */

import type { IssueCollector } from './issues'

export function readObject(issues: IssueCollector, path: string, value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.add(path, `期望一个对象，实际是 ${describe(value)}`)
    return null
  }
  return value as Record<string, unknown>
}

export interface StringOptions {
  readonly minLength?: number
  readonly pattern?: RegExp
  readonly patternHint?: string
}

export function readString(issues: IssueCollector, path: string, value: unknown, options: StringOptions = {}): string | null {
  if (typeof value !== 'string') {
    issues.add(path, `期望一个字符串，实际是 ${describe(value)}`)
    return null
  }
  if (value.length < (options.minLength ?? 1)) {
    issues.add(path, '不能为空')
    return null
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    issues.add(path, options.patternHint ?? `格式不合法：${JSON.stringify(value)}`)
    return null
  }
  return value
}

/** 读一个「可以不配」的字符串：缺省和 `null` 都算没配。 */
export function readOptionalString(issues: IssueCollector, path: string, value: unknown, options: StringOptions = {}): string | null {
  if (value === undefined || value === null) return null
  return readString(issues, path, value, options)
}

export interface IntOptions {
  readonly min?: number
  readonly max?: number
}

/**
 * 把「看起来是数字的字符串」还原成数字。
 *
 * 必须有这一步，因为环境变量展开的结果**永远是字符串**：`"hostPort": "${ABX_PORT}"`
 * 展开出来是 `"8123"`，不是 `8123`。没有这层还原的话，配置文件里所有
 * 「端口 / 限额之类想用环境变量控制」的字段都是写了就报错，
 * 而报错信息（「期望一个整数，实际是 "8123"」）看起来还像是用户写错了。
 *
 * 只认完整的数字字面量：`"8123 "`（带空格）不认，`"80abc"` 不认，
 * `""` 也不认——宽松到能把 `Number()` 那套 `"" → 0`、`"0x10" → 16`
 * 的怪癖放进来，配置里的 typo 就会变成静默的错值。
 */
function coerceNumericString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value
  return Number(trimmed)
}

export function readInt(issues: IssueCollector, path: string, value: unknown, options: IntOptions = {}): number | null {
  value = coerceNumericString(value)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.add(path, `期望一个整数，实际是 ${describe(value)}`)
    return null
  }
  if (options.min !== undefined && value < options.min) {
    issues.add(path, `不能小于 ${options.min}`)
    return null
  }
  if (options.max !== undefined && value > options.max) {
    issues.add(path, `不能大于 ${options.max}`)
    return null
  }
  return value
}

export interface NumberOptions {
  readonly min?: number
  readonly max?: number
  /** 是否必须是整数。默认不要求。 */
  readonly integer?: boolean
}

export function readNumber(issues: IssueCollector, path: string, value: unknown, options: NumberOptions = {}): number | null {
  value = coerceNumericString(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.add(path, `期望一个数字，实际是 ${describe(value)}`)
    return null
  }
  if (options.integer === true && !Number.isInteger(value)) {
    issues.add(path, '必须是整数')
    return null
  }
  if (options.min !== undefined && value < options.min) {
    issues.add(path, `不能小于 ${options.min}`)
    return null
  }
  if (options.max !== undefined && value > options.max) {
    issues.add(path, `不能大于 ${options.max}`)
    return null
  }
  return value
}

export function readBoolean(issues: IssueCollector, path: string, value: unknown): boolean | null {
  if (typeof value !== 'boolean') {
    issues.add(path, `期望 true 或 false，实际是 ${describe(value)}`)
    return null
  }
  return value
}

export function readStringArray(issues: IssueCollector, path: string, value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    issues.add(path, `期望一个数组，实际是 ${describe(value)}`)
    return null
  }
  const output: string[] = []
  value.forEach((item, index) => {
    const parsed = readString(issues, `${path}[${index}]`, item)
    if (parsed !== null) output.push(parsed)
  })
  return output
}

/** 报错文案里描述一个值，但不把长字符串原样倒出来——它有可能就是那个秘密。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'string') {
    return value.length <= 24 ? JSON.stringify(value) : `一个 ${value.length} 字符的字符串`
  }
  return typeof value
}
