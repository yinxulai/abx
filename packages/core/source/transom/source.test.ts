/**
 * 来源闸门的用例。
 *
 * 这里全部用**真的临时目录与真的软链**，不 mock `fs`：这一层判的就是「文件系统的真相」
 * ——软链指到哪儿、什么是普通文件——把它换成假的，验的就只是我自己的假设。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_DELIVERABLE_BYTES } from '@abx/contracts'
import { resolveCellSource, type CellRoot } from './source'

const WORKDIR_CELL = '/workspace'
const STATE_CELL = '/home/node/.claude'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

/** 造一个「宿主上的会话」：`<tmp>/task` 与 `<tmp>/state`，分别挂到两个舱内路径上。 */
function session(): { taskDir: string; stateDir: string; roots: readonly CellRoot[] } {
  const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-'))
  directories.push(base)
  const taskDir = path.join(base, 'task')
  const stateDir = path.join(base, 'state')
  mkdirSync(taskDir)
  mkdirSync(stateDir)
  return {
    taskDir,
    stateDir,
    roots: [
      { cellPath: WORKDIR_CELL, hostPath: taskDir, kind: 'workdir' },
      { cellPath: STATE_CELL, hostPath: stateDir, kind: 'state' },
    ],
  }
}

function succeed(result: ReturnType<typeof resolveCellSource>) {
  if (!result.ok) throw new Error(`本来该通过，却被拒了：${result.reason}`)
  return result.source
}

function reasonOf(result: ReturnType<typeof resolveCellSource>): string {
  if (result.ok) throw new Error('本来该被拒，却通过了')
  return result.reason
}

describe('把舱内路径翻成宿主上的文件', () => {
  it('工作目录里的文件：翻出来就是宿主上同一个文件', () => {
    const { taskDir, roots } = session()
    writeFileSync(path.join(taskDir, 'report.md'), '# hi')

    const source = succeed(resolveCellSource({ cellPath: '/workspace/report.md', roots }))
    expect(source.hostPath).toBe(path.join(taskDir, 'report.md'))
    expect(source.cellPath).toBe('/workspace/report.md')
    expect(source.fileName).toBe('report.md')
    expect(source.size).toBe(4)
    expect(source.kind).toBe('workdir')
  })

  it('子目录里的文件也认，而且记的是归一化之后的舱内路径', () => {
    const { taskDir, roots } = session()
    mkdirSync(path.join(taskDir, 'out'))
    writeFileSync(path.join(taskDir, 'out', 'chart.png'), 'x')

    const source = succeed(resolveCellSource({ cellPath: '/workspace/./out//chart.png', roots }))
    expect(source.hostPath).toBe(path.join(taskDir, 'out', 'chart.png'))
    expect(source.cellPath).toBe('/workspace/out/chart.png')
    expect(source.fileName).toBe('chart.png')
  })

  it('状态目录里的文件也认，而且报得出它是哪一类根', () => {
    const { stateDir, roots } = session()
    writeFileSync(path.join(stateDir, 'notes.md'), 'x')

    const source = succeed(resolveCellSource({ cellPath: `${STATE_CELL}/notes.md`, roots }))
    expect(source.hostPath).toBe(path.join(stateDir, 'notes.md'))
    expect(source.kind).toBe('state')
  })

  it('根自己也能被解析的软链：任务目录在 /tmp → /private/tmp 这类地方也照样放行', () => {
    // 不解析根那一侧的软链，合法文件会被判成逃逸——一道永远在报错的闸门等于没有闸门。
    const { taskDir, roots } = session()
    const link = `${taskDir}-link`
    symlinkSync(taskDir, link)
    directories.push(link)
    writeFileSync(path.join(taskDir, 'a.txt'), 'x')

    const throughLink: readonly CellRoot[] = [{ cellPath: WORKDIR_CELL, hostPath: link, kind: 'workdir' }]
    expect(succeed(resolveCellSource({ cellPath: '/workspace/a.txt', roots: throughLink })).size).toBe(1)
    // 而按字面路径判的那一份也还在（roots 里两条根都指向同一个真目录）。
    expect(succeed(resolveCellSource({ cellPath: '/workspace/a.txt', roots })).size).toBe(1)
  })

  it('根内部的软链是合法的：指到别处去才算逃逸', () => {
    const { taskDir, roots } = session()
    writeFileSync(path.join(taskDir, 'real.md'), 'hello')
    symlinkSync(path.join(taskDir, 'real.md'), path.join(taskDir, 'alias.md'))

    const source = succeed(resolveCellSource({ cellPath: '/workspace/alias.md', roots }))
    expect(source.hostPath).toBe(path.join(taskDir, 'real.md'))
    expect(source.size).toBe(5)
  })
})

describe('拒绝：来源必须真的在舱内的会话目录里', () => {
  it('软链指到会话目录之外 → 拒绝，而且把两边都写出来', () => {
    const { taskDir, roots } = session()
    const outside = path.join(path.dirname(taskDir), 'host-secret.txt')
    writeFileSync(outside, 'host only')
    symlinkSync(outside, path.join(taskDir, 'leak.txt'))

    const reason = reasonOf(resolveCellSource({ cellPath: '/workspace/leak.txt', roots }))
    expect(reason).toContain('解析软链之后落在了会话目录之外')
    expect(reason).toContain(outside)
    expect(reason).toContain(taskDir)
  })

  it('绝对路径指到会话目录之外 → 拒绝', () => {
    const { roots } = session()
    const reason = reasonOf(resolveCellSource({ cellPath: '/etc/passwd', roots }))
    expect(reason).toContain('不在这次会话的舱内目录里')
    // 说清楚能递的是哪儿，否则舱内那个 agent 只能瞎试。
    expect(reason).toContain(WORKDIR_CELL)
    expect(reason).toContain(STATE_CELL)
  })

  it('用 .. 走出去的写法 → 直接拒绝，理由点名 ..', () => {
    const { roots } = session()
    expect(reasonOf(resolveCellSource({ cellPath: '/workspace/../../etc/passwd', roots }))).toContain('..')
    expect(reasonOf(resolveCellSource({ cellPath: '/workspace/../state/x', roots }))).toContain('..')
  })

  it('相对路径 → 拒绝（它的含义取决于谁在哪儿跑）', () => {
    const { roots } = session()
    expect(reasonOf(resolveCellSource({ cellPath: 'report.md', roots }))).toContain('绝对路径')
    expect(reasonOf(resolveCellSource({ cellPath: './report.md', roots }))).toContain('绝对路径')
  })

  it('空路径与空字节 → 拒绝', () => {
    const { roots } = session()
    expect(reasonOf(resolveCellSource({ cellPath: '', roots }))).toContain('没有给路径')
    expect(reasonOf(resolveCellSource({ cellPath: '   ', roots }))).toContain('没有给路径')
    expect(reasonOf(resolveCellSource({ cellPath: '/workspace/a\0b', roots }))).toContain('空字节')
  })

  it('文件不存在 → 拒绝，而不是递出一个悬空的引用', () => {
    const { roots } = session()
    const reason = reasonOf(resolveCellSource({ cellPath: '/workspace/nope.md', roots }))
    expect(reason).toContain('找不到这个文件')
    expect(reason).toContain('它不存在')
  })

  it('目录 → 拒绝：传递窗只递单个文件', () => {
    const { taskDir, roots } = session()
    mkdirSync(path.join(taskDir, 'out'))
    const reason = reasonOf(resolveCellSource({ cellPath: '/workspace/out', roots }))
    expect(reason).toContain('不是一个普通文件')
    expect(reason).toContain('目录')
  })

  it('超过 64 MiB → 拒绝，并说清多大、上限多少、为什么不截断', () => {
    const { taskDir, roots } = session()
    const big = path.join(taskDir, 'big.bin')
    writeFileSync(big, '')
    // 稀疏文件：报告的大小是真的，磁盘上不占那么大，用例跑得动。
    truncateSync(big, MAX_DELIVERABLE_BYTES + 1)

    const reason = reasonOf(resolveCellSource({ cellPath: '/workspace/big.bin', roots }))
    expect(reason).toContain('64.0 MiB')
    expect(reason).toContain('超过了单次交付的上限')
    expect(reason).toContain('不会被截断')
  })

  it('正好等于上限 → 放行（上限是「不超过」）', () => {
    const { taskDir, roots } = session()
    const edge = path.join(taskDir, 'edge.bin')
    writeFileSync(edge, '')
    truncateSync(edge, MAX_DELIVERABLE_BYTES)

    expect(succeed(resolveCellSource({ cellPath: '/workspace/edge.bin', roots })).size).toBe(MAX_DELIVERABLE_BYTES)
  })

  it('没有任何根时，一切都拒——挂载表是空的，就没有「舱内」可言', () => {
    const reason = reasonOf(resolveCellSource({ cellPath: '/workspace/report.md', roots: [] }))
    expect(reason).toContain('不在这次会话的舱内目录里')
  })
})

describe('嵌套的根：取最长的那一条', () => {
  it('状态目录长在工作目录里时，按最长前缀归到状态目录', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-nest-'))
    directories.push(base)
    const outer = path.join(base, 'outer')
    const inner = path.join(outer, 'inner')
    mkdirSync(inner, { recursive: true })
    writeFileSync(path.join(inner, 'f.txt'), 'x')
    writeFileSync(path.join(outer, 'g.txt'), 'x')

    const roots: readonly CellRoot[] = [
      { cellPath: '/workspace', hostPath: outer, kind: 'workdir' },
      { cellPath: '/workspace/inner', hostPath: inner, kind: 'state' },
    ]
    expect(succeed(resolveCellSource({ cellPath: '/workspace/inner/f.txt', roots })).kind).toBe('state')
    expect(succeed(resolveCellSource({ cellPath: '/workspace/g.txt', roots })).kind).toBe('workdir')
  })
})
