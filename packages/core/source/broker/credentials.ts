/**
 * 凭据解析与注入。
 *
 * 这个文件唯一的目的：让真实密钥在「从环境变量/文件读出来」到「写进转发请求头」
 * 之间那几微秒里，只以一个**拒绝被打印**的对象形式存在。
 *
 * `SecretValue` 的 `toString` / `toJSON` 都返回 `[abx:secret]`。于是下面这些
 * 常见事故全部变成无害的：
 *
 *   console.log(`转发到 ${upstream.id}，token=${secret}`)   → token=[abx:secret]
 *   JSON.stringify({ ...context, secret })                → "secret":"[abx:secret]"
 *   throw new Error(`bad secret ${secret}`)               → bad secret [abx:secret]
 *
 * 模板字符串和 JSON.stringify 都会走这两个方法，所以不用指望每个调用点都记得脱敏。
 * 要拿到真值只有一条路：显式调 `reveal()`，而它在整个仓库里只出现在拼请求头的那一行。
 */

import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Upstream } from '@abx/contracts'

const REDACTED = '[abx:secret]'

export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** 唯一能拿到明文的地方。 */
  reveal(): string {
    return this.#value
  }

  /** 长度可以在不泄漏内容的前提下用于日志（「密钥是空的」这种问题得能查）。 */
  get length(): number {
    return this.#value.length
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  /** 让 `util.inspect` 也不会把值倒出来。 */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}

export type SecretFailureReason = 'env-missing' | 'file-unreadable' | 'empty'

export type SecretResolution =
  | {
      readonly ok: true
      readonly secret: SecretValue
      readonly source: 'env' | 'file'
      /** 环境变量名或文件路径。可以进日志——它本来就是配置里的引用。 */
      readonly reference: string
    }
  | {
      readonly ok: false
      readonly reason: SecretFailureReason
      readonly reference: string
      /** 出错说明。**不含密钥内容**。 */
      readonly detail: string
    }

export interface SecretDependencies {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly readFile: (path: string) => string
}

/**
 * 按上游配置取出密钥。
 *
 * 三种失败分开报，因为它们对应的修法完全不同：变量没导出、路径写错、文件是空的。
 * 合成一句「拿不到密钥」会让人从「配置是不是写错了」开始查，而实际上只是
 * 忘了 `export`。
 */
export function resolveUpstreamSecret(upstream: Upstream, deps: SecretDependencies): SecretResolution {
  if (upstream.secretEnv !== null) {
    const value = deps.env[upstream.secretEnv]
    if (value === undefined) {
      return {
        ok: false,
        reason: 'env-missing',
        reference: upstream.secretEnv,
        detail: `环境变量 ${upstream.secretEnv} 没有设置`,
      }
    }
    if (value.trim() === '') {
      return { ok: false, reason: 'empty', reference: upstream.secretEnv, detail: `环境变量 ${upstream.secretEnv} 是空的` }
    }
    return { ok: true, secret: new SecretValue(value.trim()), source: 'env', reference: upstream.secretEnv }
  }

  if (upstream.secretFile !== null) {
    let text: string
    try {
      text = deps.readFile(upstream.secretFile)
    } catch (error) {
      return {
        ok: false,
        reason: 'file-unreadable',
        reference: upstream.secretFile,
        detail: `读不到凭据文件：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const value = text.trim()
    if (value === '') {
      return { ok: false, reason: 'empty', reference: upstream.secretFile, detail: '凭据文件是空的' }
    }
    return { ok: true, secret: new SecretValue(value), source: 'file', reference: upstream.secretFile }
  }

  // 配置校验已经保证不会走到这儿；留一条是为了让类型收敛，也为了万一有人绕过校验时
  // 拿到的是「拒绝」而不是一个空密钥。
  return { ok: false, reason: 'env-missing', reference: '', detail: '这个上游既没有 secretEnv 也没有 secretFile' }
}

/**
 * 拼出请求头的值：`Bearer sk-xxx` 或者（没有 scheme 时）裸密钥。
 *
 * scheme 为空串按没有处理：`"authScheme": ""` 和 `"authScheme": null` 应该是同一件事，
 * 否则配置里一个看不见的空格会拼出一个 `" sk-xxx"` 这样的头。
 */
export function buildAuthHeaderValue(scheme: string | null, secret: SecretValue): string {
  const trimmed = scheme?.trim() ?? ''
  if (trimmed === '') return secret.reveal()
  return `${trimmed} ${secret.reveal()}`
}

/**
 * 配置里所有凭据引用的名字（环境变量名 + 文件路径）。
 *
 * session 用它从要注入舱内的环境里把真实密钥剃掉。放在这里而不是 session 里，
 * 是因为「哪些名字算秘密」这件事的定义权应该跟着凭据解析走，两处各写一份迟早会漏。
 */
export function collectSecretEnvNames(upstreams: readonly Upstream[]): readonly string[] {
  const names: string[] = []
  for (const upstream of upstreams) {
    if (upstream.secretEnv !== null) names.push(upstream.secretEnv)
  }
  return names
}

/**
 * 定长比较，避免用 `===` 比令牌时泄漏「前几个字符对了」。
 *
 * 长度不同直接返回 false 会泄漏长度，所以先把两边都补到同一长度再比。
 * 对这个威胁模型来说这已经够了：攻击者要利用它，得先能反复精确测量
 * 本地回环上的响应时间差。
 */
export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  const size = Math.max(leftBuffer.length, rightBuffer.length, 1)

  const paddedLeft = Buffer.alloc(size)
  const paddedRight = Buffer.alloc(size)
  leftBuffer.copy(paddedLeft)
  rightBuffer.copy(paddedRight)

  const equal = timingSafeEqual(paddedLeft, paddedRight)
  return equal && leftBuffer.length === rightBuffer.length
}

export const defaultSecretDependencies: Pick<SecretDependencies, 'readFile'> = {
  readFile: (path: string) => readFileSync(path, 'utf8'),
}
