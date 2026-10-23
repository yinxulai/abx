/**
 * 一次拖放里有哪几项、每一项是文件还是目录。
 *
 * 这个文件只干这一件事，但它挡的是那道**著名陷阱**：**不能用 `File.size === 0`
 * 判断目录**——0 字节的空文件也是 0，用它判的话，一个空文件会被当成目录挂进去，
 * 而目录会被当成文件。浏览器能给的正确判据只有 `DataTransferItem.webkitGetAsEntry()`
 * 的 `isDirectory`（`File.type` 同样是空的，也判不了）。
 *
 * 这里给的 `kind` 只是**即时预览**：面板要能立刻画出图标，而真相在宿主那一侧
 * ——`resolveSharedMounts()` 会 stat 一遍，以它为准（软链也要按目标判）。
 * 所以这个文件的输出**不写进任何持久化文件**：`shared.json` 里的 kind 永远来自 stat。
 *
 * 纯函数 + 不 import `electron`：宿主能力（`webUtils.getPathForFile`）由调用方
 * 以 `pathFor` 传进来，于是这一段能在 node 里直接测。
 */

import type { SharedEntry, SharedEntryKind } from '@abx/contracts'

/** `webkitGetAsEntry()` 的结果里这一层用得着的东西（不依赖 DOM 的 FileSystemEntry 类型）。 */
export interface FileSystemEntryLike {
  readonly isDirectory: boolean
}

/** 拖放里的一项：浏览器给的那两样。 */
export interface DropItemLike<F extends object> {
  /** `DataTransferItem.webkitGetAsEntry()`；拿不到就是 `null`。 */
  readonly entry: FileSystemEntryLike | null
  /** `DataTransferItem.getAsFile()`；不是磁盘上的东西（拖来的选区文本）就是 `null`。 */
  readonly file: F | null
}

/**
 * 即时预览用的 kind。
 *
 * 注意它**看不到** `size`：类型上就拿不到，所以「用大小判目录」这种错在这里
 * 写不出来。看不出来就按文件算——预览错了只是图标闪一下，随后宿主的判定会覆盖它。
 */
export function previewKind(entry: FileSystemEntryLike | null | undefined): SharedEntryKind {
  return entry?.isDirectory === true ? 'directory' : 'file'
}

/**
 * 把一次拖放的项收成条目，按绝对路径去重。
 *
 * `pathFor` 就是 `webUtils.getPathForFile`（那是宿主能力）。它可能返回空串
 * ——不是磁盘上的东西时就是这样——那些项直接跳过，与旧行为一致。
 */
export function collectDroppedItems<F extends object>(items: readonly DropItemLike<F>[], pathFor: (file: F) => string): readonly SharedEntry[] {
  const collected: SharedEntry[] = []
  for (const item of items) {
    if (item.file === null) continue
    const filePath = pathFor(item.file)
    if (filePath === '') continue
    if (collected.some((existing) => existing.path === filePath)) continue
    collected.push({ path: filePath, kind: previewKind(item.entry) })
  }
  return collected
}
