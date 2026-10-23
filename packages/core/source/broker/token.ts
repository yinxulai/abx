/**
 * 舱令牌。
 *
 * 它防的不是舱内的 agent（agent 本来就能读到它），而是同一台机器上的**其他**进程：
 * docker 网桥上还连着别的容器时，谁都能往 `172.17.0.1:8789` 打请求。
 * 令牌把舱面从「网桥上人人可用」收窄成「拿着这次会话令牌的人可用」。
 *
 * 令牌文件落盘是为了让两个进程能共用它：`abx broker` 在后台起，
 * `abx open` 前后脚起来时要拿到同一个值。权限 0600——它是这次会话的凭据，
 * 虽然是一次性的，但没有理由让同机器上的其他用户读到。
 *
 * 格式是 `abx_cell_<64 位十六进制>`：前缀的理由见 {@link CELL_TOKEN_PREFIX}。
 * 令牌的**字节数**（32 字节随机）没有因为加前缀而变化，改的只是它长什么样。
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const CELL_TOKEN_FILE_NAME = '.abx-cell-token'

/**
 * 舱令牌的固定前缀。
 *
 * **它不是为了「认出这是我们的令牌」，是为了「能被扫到」。** 令牌一定会漏出去一些：
 * 它在舱内 agent 的 `BASE_URL` 里，agent 复述配置、报错、把 URL 贴进 issue 都是
 * 常规操作，日志和 CI 输出里也会出现。有了固定前缀，「泄漏检测」就从语义猜测变成
 * 一次字符串匹配——提交前钩子、日志采集、`grep -rn abx_cell_` 用同一条规则就够；
 * 而纯 hex 的令牌跟任何一个 sha256 长得一模一样，没法扫。
 *
 * 反过来：**前缀不是信任标记。** 带着前缀不等于有效，仍然要能在注册表里查到才算数
 * （见 `route.ts` 的 `extractCellToken` 与 `registry.ts`）。把前缀当成「自己人」的
 * 判据，等于给所有人发一把看起来像钥匙的塑料片。
 */
export const CELL_TOKEN_PREFIX = 'abx_cell_'

export function generateCellToken(): string {
  return `${CELL_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

/** 令牌文件放在审计流水旁边：两个都是「这次运行留下的东西」，放一起好清理。 */
export function defaultCellTokenPath(auditPath: string): string {
  return path.join(path.dirname(path.resolve(auditPath)), CELL_TOKEN_FILE_NAME)
}

export function readCellTokenFile(filePath: string): string | null {
  try {
    const value = readFileSync(filePath, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

export function writeCellTokenFile(filePath: string, token: string): void {
  writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
}
