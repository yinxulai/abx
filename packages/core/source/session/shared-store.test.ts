import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SharedEntry } from '@abx/contracts'
import { RUNNING_PLATFORM, RUNNING_VOCABULARY } from '../test-support'
import { INSTANCES_ROOT_ENV } from './instance'
import { addSharedEntries, defaultSharedListPath, markMissingEntries, readSharedEntries, writeSharedEntries } from './shared-store'

/*
 * 持久化这一层要证明的是三件事：**活过重启**、**失效不删**、**坏文件不炸**。
 * 容器那一边（挂上去之后舱内真的看得见）由 e2e-shared.sh 验。
 */

let work: string
let listPath: string

function entry(target: string, kind: 'file' | 'directory' = 'directory'): SharedEntry {
  return { path: target, kind }
}

/** 宿主那边的路径按跑测试这台机器造。`/home/dev` 这种写法只在 POSIX 上是对的。 */
const HOST = RUNNING_VOCABULARY

beforeEach(() => {
  work = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-shared-store-')))
  listPath = path.join(work, '.abx', 'shared.json')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('defaultSharedListPath', () => {
  it('默认落在 ~/.abx/shared.json，与实例根同住一个目录', () => {
    expect(defaultSharedListPath({}, HOST.home)).toBe(HOST.underHome('.abx', 'shared.json'))
  })

  it('ABX_INSTANCES_ROOT 一改，实例目录与这份列表一起搬走', () => {
    const root = HOST.join(HOST.outsideDir, 'abx', 'instances')
    expect(defaultSharedListPath({ [INSTANCES_ROOT_ENV]: root }, HOST.home)).toBe(HOST.join(HOST.outsideDir, 'abx', 'shared.json'))
  })
})

describe('写与读', () => {
  it('写下去的能原样读回来——这就是「活过重启」', () => {
    const directory = path.join(work, 'projects')
    mkdirSync(directory)
    writeSharedEntries(listPath, [entry(directory), entry(path.join(work, 'a.md'), 'file')])

    // 换一个进程视角：只从文件读，不碰内存里的那个数组。
    expect(readSharedEntries(listPath)).toEqual([entry(directory), entry(path.join(work, 'a.md'), 'file')])
  })

  it('目录与文件都是 0600 / 0700：这份列表是「他这台机器上有什么」的索引', () => {
    writeSharedEntries(listPath, [])

    if (RUNNING_PLATFORM === 'win32') {
      // Windows 没有 POSIX 权限位，`mode` 里只剩「只读」那一位（值是 `statSync`
      // 合成的，写死数字等于在断言 Node 的内部实现）。能验的是同一件事的另一半：
      // 列表**不是只读的**——面板要能继续往里加条目。
      expect(statSync(listPath).mode & 0o200).not.toBe(0)
      expect(statSync(path.dirname(listPath)).mode & 0o200).not.toBe(0)
    } else {
      expect(statSync(listPath).mode & 0o777).toBe(0o600)
      expect(statSync(path.dirname(listPath)).mode & 0o777).toBe(0o700)
    }
  })

  it('第一次跑（文件不在）给空数组，不抛', () => {
    expect(readSharedEntries(path.join(work, 'nope.json'))).toEqual([])
  })

  it('JSON 坏了给空数组：一个坏字节不该让面板打不开', () => {
    mkdirSync(path.dirname(listPath), { recursive: true })
    writeFileSync(listPath, '{"entries": [ this is not json')

    expect(readSharedEntries(listPath)).toEqual([])
  })

  it('形状不对（顶层不是 { entries: [...] }）也当空', () => {
    mkdirSync(path.dirname(listPath), { recursive: true })
    writeFileSync(listPath, JSON.stringify({ entries: 'nope' }))
    expect(readSharedEntries(listPath)).toEqual([])
    writeFileSync(listPath, JSON.stringify([HOST.underHome('notes')]))
    expect(readSharedEntries(listPath)).toEqual([])
  })

  it('单条记录不合法只丢那一条，别的照读——列表是手工改过也不该整份报废', () => {
    mkdirSync(path.dirname(listPath), { recursive: true })
    writeFileSync(
      listPath,
      JSON.stringify({
        entries: [
          { path: HOST.underHome('notes'), kind: 'directory' },
          { path: 'relative/notes', kind: 'directory' },
          { path: HOST.underHome('secrets'), kind: 'symlink' },
          { path: HOST.underHome('a.md'), kind: 'file' },
        ],
      }),
    )

    expect(readSharedEntries(listPath)).toEqual([entry(HOST.underHome('notes')), entry(HOST.underHome('a.md'), 'file')])
  })

  it('写入是「先临时文件再改名」：中断最多留下一个 .tmp，原列表还在', () => {
    writeSharedEntries(listPath, [entry(HOST.underHome('notes'))])
    writeSharedEntries(listPath, [entry(HOST.underHome('notes')), entry(HOST.underHome('data'))])

    expect(readSharedEntries(listPath)).toHaveLength(2)
    // 这一条要验的是「文件在磁盘上真的被换过了」，所以读原始文本。
    // 但比的东西必须是**编码之后**的样子：落盘的是 JSON，Windows 路径里的每个 `\`
    // 在文件里都写成 `\\`。直接 `toContain(路径)` 会在 Windows 上红，
    // 而它想说的跟分隔符毫无关系。
    const raw = readFileSync(listPath, 'utf8')
    const encoded = JSON.stringify(HOST.underHome('data')).slice(1, -1)
    expect(raw).toContain(encoded)
  })
})

describe('addSharedEntries', () => {
  it('同一个路径拖两次只留一条', () => {
    const first = entry(HOST.underHome('notes'))
    expect(addSharedEntries([first], [first])).toEqual([first])
  })

  it('顺序是加入的次序：老的在前、新的在后', () => {
    const merged = addSharedEntries([entry(HOST.join(HOST.fsRoot, 'a'))], [
      entry(HOST.join(HOST.fsRoot, 'b')),
      entry(HOST.join(HOST.fsRoot, 'c')),
    ])
    expect(merged.map((item) => item.path)).toEqual([
      HOST.join(HOST.fsRoot, 'a'),
      HOST.join(HOST.fsRoot, 'b'),
      HOST.join(HOST.fsRoot, 'c'),
    ])
  })

  it('同一条路径第二次进来时以新的为准——kind 是宿主 stat 出来的，新的那次更近', () => {
    const merged = addSharedEntries([entry(HOST.underHome('thing'), 'file')], [entry(HOST.underHome('thing'), 'directory')])
    expect(merged).toEqual([entry(HOST.underHome('thing'), 'directory')])
  })
})

describe('markMissingEntries', () => {
  it('宿主上还在的条目 missing=false，kind 用宿主现在说的', () => {
    const directory = path.join(work, 'notes')
    mkdirSync(directory)

    expect(markMissingEntries([entry(directory, 'file')])).toEqual([{ path: directory, kind: 'directory', missing: false }])
  })

  it('被删掉的条目标成 missing，但**留在列表里**——不许静默移除', () => {
    const gone = path.join(work, 'gone')
    const marked = markMissingEntries([entry(gone)])

    expect(marked).toEqual([{ path: gone, kind: 'directory', missing: true }])
    // 关掉再打开还是这一条：它没有被写没了。
    writeSharedEntries(listPath, [entry(gone)])
    expect(readSharedEntries(listPath)).toEqual([entry(gone)])
    expect(markMissingEntries(readSharedEntries(listPath))[0]?.missing).toBe(true)
  })

  it('文件与目录混在一起时各判各的', () => {
    const directory = path.join(work, 'notes')
    mkdirSync(directory)
    const file = path.join(work, 'a.md')
    writeFileSync(file, 'x\n')

    const marked = markMissingEntries([entry(directory), entry(file, 'file'), entry(path.join(work, 'nope'))])

    expect(marked.map((item) => item.missing)).toEqual([false, false, true])
  })
})
