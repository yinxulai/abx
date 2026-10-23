import { describe, expect, it } from 'vitest'
import { collectDroppedItems, previewKind, type DropItemLike } from './drop-entry'

/*
 * 拖放归类的用例。宿主能力（`webUtils.getPathForFile`）由用例替身提供，
 * 所以这一层能在没有 Electron、没有浏览器的机器上测。
 */

/** 只有 `name` 的替身：这一层从 `File` 上唯一需要的就是「能换出路径」。 */
interface FakeFile {
  readonly name: string
  /** 刻意放进来：**空的目录和空的文件都是 0**，谁都不许拿它判断类型。 */
  readonly size: number
}

function file(name: string, size = 0): FakeFile {
  return { name, size }
}

function item(entry: DropItemLike<FakeFile>['entry'], current: FakeFile | null): DropItemLike<FakeFile> {
  return { entry, file: current }
}

const pathFor = (input: FakeFile): string => `/Users/alain/${input.name}`

describe('previewKind', () => {
  it('目录就是目录', () => {
    expect(previewKind({ isDirectory: true })).toBe('directory')
  })

  it('文件就是文件', () => {
    expect(previewKind({ isDirectory: false })).toBe('file')
  })

  it('拿不到 entry 时按文件算——预览错了只是一闪，随后宿主的判定会覆盖它', () => {
    expect(previewKind(null)).toBe('file')
    expect(previewKind(undefined)).toBe('file')
  })

  it('判据只有 isDirectory：0 字节的空文件与空目录在这里分得开', () => {
    // File.size 判不出来：两者都是 0。所以判据只能是 isDirectory。
    const emptyFile = file('empty.txt', 0)
    const emptyDirectory = file('empty-dir', 0)

    expect(previewKind({ isDirectory: false })).toBe('file')
    expect(previewKind({ isDirectory: true })).toBe('directory')
    expect(emptyFile.size).toBe(emptyDirectory.size)
  })
})

describe('collectDroppedItems', () => {
  it('文件和目录都收，各自带上预览的 kind', () => {
    const collected = collectDroppedItems(
      [item({ isDirectory: true }, file('notes')), item({ isDirectory: false }, file('design.pdf'))],
      pathFor,
    )

    expect(collected).toEqual([
      { path: '/Users/alain/notes', kind: 'directory' },
      { path: '/Users/alain/design.pdf', kind: 'file' },
    ])
  })

  it('同一个路径拖两次只算一项', () => {
    const collected = collectDroppedItems([item(null, file('a.md')), item(null, file('a.md'))], pathFor)
    expect(collected).toHaveLength(1)
  })

  it('不是磁盘上的东西（换不出路径）跳过', () => {
    const collected = collectDroppedItems([item(null, file('selection')), item(null, null)], () => '')
    expect(collected).toEqual([])
  })

  it('保留拖入的次序：面板上那一行行就是用户眼睛看到的顺序', () => {
    const collected = collectDroppedItems([item(null, file('b.md')), item(null, file('a.md'))], pathFor)
    expect(collected.map((entry) => entry.path)).toEqual(['/Users/alain/b.md', '/Users/alain/a.md'])
  })
})
