import { describe, expect, it } from 'vitest'
import { parseSharedEntry, sharedEntrySchema } from './shared-entry'

/*
 * 这一层只判**形状**：绝对路径、没有 `..`、kind 是那两类之一。
 * 「能不能挂」是 core 的事，不在这里重复。
 */

describe('sharedEntrySchema', () => {
  it('接受一条文件条目与一条目录条目', () => {
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/notes.md', kind: 'file' }).success).toBe(true)
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/notes', kind: 'directory' }).success).toBe(true)
  })

  it('空路径拒绝——空串几乎总是「复制了样例、忘了填」', () => {
    expect(sharedEntrySchema.safeParse({ path: '', kind: 'file' }).success).toBe(false)
  })

  it('相对路径拒绝：它的含义取决于谁在哪儿跑', () => {
    expect(sharedEntrySchema.safeParse({ path: 'notes/design.md', kind: 'file' }).success).toBe(false)
    expect(sharedEntrySchema.safeParse({ path: './notes', kind: 'directory' }).success).toBe(false)
  })

  it('路径里的 .. 拒绝：它能把一个人畜无害的路径变成 /home', () => {
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/../../etc', kind: 'directory' }).success).toBe(false)
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/..', kind: 'file' }).success).toBe(false)
  })

  it('..foo 不是 ..：那是合法的文件名', () => {
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/..notes', kind: 'file' }).success).toBe(true)
  })

  it('Windows 的绝对路径也认：盘符与 UNC 两种形状', () => {
    // 这一条是回归测试。原先只认 `startsWith('/')`，于是 Windows 上用户拖进来的
    // **每一条**都在这里被拒，而表现是「拖了没反应」——存进 `shared.json` 又读不出来，
    // 中间一句话都没有。形状判定在这一层（浏览器产物里拿不到平台），
    // 分平台的闸门在 `resolveSharedMounts()`。
    for (const path of ['C:\\Users\\dev\\notes', 'D:\\projects\\thing', 'C:/Users/dev/notes', '\\\\server\\share\\notes']) {
      expect(sharedEntrySchema.safeParse({ path, kind: 'directory' }).success, path).toBe(true)
    }
  })

  it('Windows 形状的相对路径照样拒绝', () => {
    expect(sharedEntrySchema.safeParse({ path: 'notes\\design.md', kind: 'file' }).success).toBe(false)
    // `C:` 单独一段不是绝对路径——那是「C 盘当前目录」，一个会随进程状态变的位置。
    expect(sharedEntrySchema.safeParse({ path: 'C:', kind: 'directory' }).success).toBe(false)
    // 单个反斜杠开头也不是 UNC。
    expect(sharedEntrySchema.safeParse({ path: '\\notes', kind: 'directory' }).success).toBe(false)
  })

  it('Windows 形状的 .. 同样拒绝，两种分隔符都算', () => {
    expect(sharedEntrySchema.safeParse({ path: 'C:\\Users\\..\\Windows', kind: 'directory' }).success).toBe(false)
    expect(sharedEntrySchema.safeParse({ path: 'C:/Users/../Windows', kind: 'directory' }).success).toBe(false)
    expect(sharedEntrySchema.safeParse({ path: '\\\\server\\share\\..\\x', kind: 'directory' }).success).toBe(false)
  })

  it('kind 只有两类，别的值拒绝', () => {
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/notes', kind: 'symlink' }).success).toBe(false)
    expect(sharedEntrySchema.safeParse({ path: '/home/dev/notes' }).success).toBe(false)
  })
})

describe('parseSharedEntry', () => {
  it('合法条目给回那个条目本身', () => {
    expect(parseSharedEntry({ path: '/home/dev/notes', kind: 'directory' })).toEqual({
      ok: true,
      entry: { path: '/home/dev/notes', kind: 'directory' },
    })
  })

  it('不合法时给得出人能读的理由，而不是抛异常', () => {
    const result = parseSharedEntry({ path: 'notes', kind: 'file' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('绝对路径')
  })

  it('完全不是对象的东西也不会让它抛', () => {
    expect(parseSharedEntry(null).ok).toBe(false)
    expect(parseSharedEntry('notes.md').ok).toBe(false)
  })
})
