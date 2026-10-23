/**
 * 舱内路径：**永远是 Linux 容器里的路径**，与宿主跑在什么系统上无关。
 *
 * 这个文件是「两种路径」这条规矩的舱内那一半（宿主那一半见
 * `../host-platform.ts`）。规矩本身只有一句话：
 *
 *   > 舱内路径用 `path.posix` 拼和判，宿主路径用平台自己的 `path` 拼和判。
 *   > 两者**永远不混**。
 *
 * **为什么值得单独一个文件。** 混起来的后果不是报错，是**静默错位**：宿主的
 * `path.join` 在 Windows 上会把 `/home/node/.claude` 拼成 `\home\node\.claude`，
 * 而字符串本身看着仍然「像个路径」，一路都不会有人抱怨。它会一路走到
 * `docker run --mount ...` 上，那时容器里挂的是一个不存在的目录——挂载参数完全正常，
 * 「让 agent 走气闸」这件事却根本没生效，而 agent 只是安静地去连了真实供应商。
 *
 * 所以这一层不只是「用 posix」，它还要**让误用变得显眼**：函数名一律带 `cell`，
 * 拿一个宿主路径进来一眼就能看出来不对。
 *
 * 不属于这里的：宿主上的 `~/.abx/instances/...`。那是宿主路径，跟着宿主走，
 * 见 `instance.ts` 的 `planInstance()`。
 */

import path from 'node:path'

/**
 * 舱内路径的字符串语义。
 *
 * 固定是 `path.posix`，**不跟平台走**——容器是 Linux，`/workspace` 与
 * `/home/node/.claude` 在 macOS 宿主和 Windows 宿主上是同一个字符串。
 */
export const CELL_PATH = path.posix

/** 拼一段舱内路径。 */
export function cellJoin(...segments: readonly string[]): string {
  return CELL_PATH.join(...segments)
}

/**
 * 把清单里那条路径展开成舱内路径。
 *
 * 清单（`AgentDefinition`）里的路径写的是 **agent 自己眼里的路径**，所以 `~` 展开成
 * 的是**舱内 home**（`session.cellHome`），不是宿主 home。这一条曾经写错过：默认取
 * `os.homedir()`，于是生成出来的挂载点是 `/home/<宿主用户>/.claude/settings.json`，
 * 而舱内 agent 只去读 `$HOME/.claude/settings.json`——挂载参数看着完全正常，
 * 配置实际没生效。
 */
export function cellHomePath(filePath: string, cellHome: string): string {
  if (filePath === '~') return cellHome
  if (filePath.startsWith('~/')) return cellJoin(cellHome, filePath.slice(2))
  return filePath
}

/** 这一段是不是绝对路径。注意用的是 posix 语义，不是宿主语义。 */
export function isCellAbsolute(cellPath: string): boolean {
  return CELL_PATH.isAbsolute(cellPath)
}

/** `candidate` 是 `cellPath` 的上级（不含相等）。 */
export function isCellAncestor(candidate: string, cellPath: string): boolean {
  return cellPath.startsWith(`${candidate}${CELL_PATH.sep}`)
}

/**
 * `child` 在 `parent` 里面（或者就是它）。
 *
 * 与宿主的 `isUnder()` 是同一套判定，但**两个都要有**：它们看着一样，接受的却是
 * 两种不同的字符串。合成一个函数就意味着「哪一半在用它」要靠调用点去猜，而猜错
 * 的那一边在 Linux 上跑得好好的。
 */
export function isUnderCellPath(child: string, parent: string): boolean {
  return child === parent || isCellAncestor(parent, child)
}

/** 舱内路径的最后一段。 */
export function cellBasename(cellPath: string): string {
  return CELL_PATH.basename(cellPath)
}

/** 舱内路径的父目录。 */
export function cellDirname(cellPath: string): string {
  return CELL_PATH.dirname(cellPath)
}
