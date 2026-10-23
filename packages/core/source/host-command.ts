/**
 * 在宿主上找一条命令（`docker`、`bwrap`……）。
 *
 * 单独一个文件而不是塞在 `docker-backend.ts` 里，是因为它跟 docker 没关系：
 * 它是**宿主平台**的一件事，跟 `host-platform.ts` 是同一层。下面这条差别就是
 * 它在 Windows 上必须单独处理的原因：
 *
 *   **Windows 上的可执行文件带扩展名。** `PATH` 里写的是目录，磁盘上叫
 *   `docker.exe`，而命令行里写的是 `docker`。只按名字去拼路径的话，一个装得好好的
 *   docker 在 Windows 上永远查不到——而它**不报错**，只是让 `abx doctor` 说一句
 *   「找不到 docker 可执行文件」，用户对着一个明明能用的 docker 发懵。
 *
 * 判定核心（`findCommandOnPath`）是**纯的**：`PATH`、`PATHEXT`、以及「这个候选路径
 * 能不能执行」全都注入进来。所以 Linux 上就能把 win32 那条分支完整跑一遍——
 * 真机上验不了的那部分，只有这样才验得到。碰真实环境的那一层是
 * `isExecutableOnPath()`，它薄到没什么可错的。
 */

import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { hostPathRulesFor } from './host-platform'
import type { HostPlatform } from './host-platform'

/**
 * `PATHEXT` 读不到时的出厂值。
 *
 * 这几个扩展名从 Windows NT 起就没变过，而 `PATHEXT` 理论上可以被用户改掉——
 * 所以它是**兜底**而不是默认：能读到就用读到的那份。
 * 大小写按惯例写大写；匹配本身由文件系统负责（Windows 上大小写不敏感）。
 */
export const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD']

/** `findCommandOnPath` 的入参：环境与 I/O 全在外部，所以它是纯函数。 */
export interface PathLookup {
  /** 宿主平台。决定要不要试扩展名、用哪个分隔符。 */
  readonly platform: HostPlatform
  /** `PATH` 拆开之后的目录列表。 */
  readonly searchDirs: readonly string[]
  /** `PATHEXT` 拆开之后的扩展名列表。POSIX 上传空数组。 */
  readonly pathExtensions: readonly string[]
  /** 这个候选路径能不能执行。注入进来，才能在别的平台上模拟。 */
  isExecutable(candidate: string): boolean
}

/** 两边的分隔符都认：Windows 上 `C:/Windows/System32/cmd.exe` 也是合法的写法。 */
function looksLikePath(command: string, platform: HostPlatform): boolean {
  if (platform === 'win32') return /[\\/]/.test(command)
  return command.includes('/')
}

/** 一条命令的全部候选路径：原样一个，Windows 上再按扩展名各来一个。 */
function candidatesFor(base: string, platform: HostPlatform, extensions: readonly string[]): readonly string[] {
  if (platform !== 'win32' || extensions.length === 0) return [base]
  return [base, ...extensions.map((extension) => `${base}${extension}`)]
}

/**
 * 这条命令在不在 `PATH` 上（或者它本身就是一条能执行的路径）。
 *
 * 三段，顺序固定：
 *   1. 带分隔符的一律当路径查——`./script`、`C:\...\docker.exe` 都走这条；
 *   2. 不带分隔符的在 `PATH` 的每个目录里拼一次；
 *   3. Windows 上每个候选再按 `PATHEXT` 试几个扩展名。
 *
 * `PATH` 里的空段（`::` 或末尾的 `:`）按惯例是「当前目录」，但这条路**故意不认**：
 * 它是「当前目录里恰好躺着一个同名程序」这类意外执行的经典来源，而这里问的是
 * 「docker 装好了没有」，不是「能不能执行当前目录里那个文件」。
 */
export function findCommandOnPath(command: string, lookup: PathLookup): boolean {
  const rules = hostPathRulesFor(lookup.platform)
  const { platform, pathExtensions } = lookup

  if (looksLikePath(command, platform)) {
    return candidatesFor(command, platform, pathExtensions).some((candidate) => lookup.isExecutable(candidate))
  }

  return lookup.searchDirs.some((directory) => {
    if (directory === '') return false
    const base = rules.path.join(directory, command)
    return candidatesFor(base, platform, pathExtensions).some((candidate) => lookup.isExecutable(candidate))
  })
}

/**
 * `docker` / `bwrap` 这类命令在这台机器上找不找得到。
 *
 * 平台是**问进来的**，不是自己读 `process.platform`：读进来的话，Windows 那条分支
 * 就只在 Windows 上跑得到，而写这段代码的机器恰恰不是 Windows（见 `host-platform.ts`）。
 *
 * `X_OK` 在 Windows 上退化成「文件存在」——那边没有 POSIX 那种可执行位，
 * 这是 Node 给的语义，也是唯一说得通的一种。
 */
export function isExecutableOnPath(command: string, platform: HostPlatform): boolean {
  return findCommandOnPath(command, {
    platform,
    // 拆 `PATH` 用的是**这台机器**的分隔符（`path.delimiter`），跟注入的平台无关：
    // 拆的是本机真实的环境变量，按别的平台拆只会得到一个假结果。
    searchDirs: (process.env['PATH'] ?? '').split(path.delimiter),
    pathExtensions: platform === 'win32' ? pathExtensionsFromEnv(process.env['PATHEXT']) : [],
    isExecutable: (candidate) => {
      try {
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
  })
}

/** `PATHEXT` 的值拆成扩展名列表；读不到或全是空的就退回出厂值。 */
function pathExtensionsFromEnv(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_WINDOWS_PATH_EXTENSIONS
  const parsed = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return parsed.length === 0 ? DEFAULT_WINDOWS_PATH_EXTENSIONS : parsed
}
