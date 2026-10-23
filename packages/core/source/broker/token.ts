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
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const CELL_TOKEN_FILE_NAME = '.abx-cell-token'

export function generateCellToken(): string {
  return randomBytes(32).toString('hex')
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
