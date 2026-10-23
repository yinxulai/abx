/**
 * 去哪儿找配置文件。
 *
 * 优先级：命令行 `--config` > 环境变量 `ABX_CONFIG` > 从当前目录往上找
 * `abx.config.json`。往上找是因为 `abx open claude ~/work/repo` 这种用法里，
 * 当前目录往往不是仓库根，而配置总在仓库根。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

export const CONFIG_FILE_NAME = 'abx.config.json'

export interface FindConfigOptions {
  readonly cwd: string
  readonly explicitPath: string | null
  readonly env: Readonly<Record<string, string | undefined>>
}

export type FindConfigResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly searched: readonly string[] }

export function findConfigFile(options: FindConfigOptions): FindConfigResult {
  if (options.explicitPath !== null) {
    return existsSync(options.explicitPath)
      ? { ok: true, path: path.resolve(options.explicitPath) }
      : { ok: false, searched: [options.explicitPath] }
  }

  const fromEnv = options.env['ABX_CONFIG']
  if (fromEnv !== undefined && fromEnv !== '') {
    return existsSync(fromEnv) ? { ok: true, path: path.resolve(fromEnv) } : { ok: false, searched: [fromEnv] }
  }

  const searched: string[] = []
  let directory = path.resolve(options.cwd)
  for (;;) {
    const candidate = path.join(directory, CONFIG_FILE_NAME)
    searched.push(candidate)
    if (existsSync(candidate)) return { ok: true, path: candidate }

    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return { ok: false, searched }
}
