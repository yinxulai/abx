/**
 * 传递窗两个动作的用例。
 *
 * **一个窗口都不弹**：`Opener` 是个接口，这里给它一个记账的替身。
 * 于是「.png 断言被打开了、.sh 与没有后缀的断言没被打开」这件事是**可以断言的**，
 * 而不是靠肉眼看屏幕。
 *
 * 另外两组是这个功能的核心判断：
 *   - 白名单之外的**两条路都拦**（publish 拦一次，open 再拦一次）；
 *   - 账写不下来时，交付会被**撤销**（「审计是承诺，不是日志」）。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Opener } from './opener'
import { createMemoryTransomLedger, type MemoryTransomLedger } from './ledger'
import { createTransomService, type TransomSession } from './service'

const CELL_ID = 'claude-20261023-abc123'
const FIXED_TIME = new Date('2026-10-23T12:00:00.000Z')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

interface StubOpener extends Opener {
  readonly calls: string[]
}

/** 记账用的替身。**不弹窗口**——这就是它能进 CI 的原因。 */
function stubOpener(): StubOpener {
  const calls: string[] = []
  return {
    name: 'stub-opener',
    calls,
    openFile(absolutePath: string): Promise<void> {
      calls.push(`open:${absolutePath}`)
      return Promise.resolve()
    },
    revealInFolder(absolutePath: string): Promise<void> {
      calls.push(`reveal:${absolutePath}`)
      return Promise.resolve()
    },
  }
}

/** 一个会失败的替身：宿主上没有打开命令时就是这样。 */
function failingOpener(message: string): Opener {
  return {
    name: 'failing-opener',
    openFile: () => Promise.reject(new Error(message)),
    revealInFolder: () => Promise.reject(new Error(message)),
  }
}

interface Fixture {
  readonly taskDir: string
  readonly stateDir: string
  readonly outboxRoot: string
  readonly session: TransomSession
  readonly ledger: MemoryTransomLedger
  readonly opener: StubOpener
  readonly service: ReturnType<typeof createTransomService>
}

interface FixtureOptions {
  /** 不传就是用那个记账的替身；`null` 表示这个平台上没有「打开」这回事。 */
  readonly opener?: Opener | null
}

function fixture(options: FixtureOptions = {}): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-svc-'))
  directories.push(base)
  const taskDir = path.join(base, 'task')
  const stateDir = path.join(base, 'state')
  const outboxRoot = path.join(base, 'outbox')
  mkdirSync(taskDir)
  mkdirSync(stateDir)

  const session: TransomSession = {
    cellId: CELL_ID,
    agentId: 'claude',
    roots: [
      { cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' },
      { cellPath: '/home/node/.claude', hostPath: stateDir, kind: 'state' },
    ],
  }
  const ledger = createMemoryTransomLedger()
  const opener = stubOpener()
  const service = createTransomService({
    outboxRoot,
    ledger,
    opener: options.opener === undefined ? opener : options.opener,
    now: () => FIXED_TIME,
  })
  return { taskDir, stateDir, outboxRoot, session, ledger, opener, service }
}

/** 在舱内的工作目录里放一个文件，路径用舱内写法。 */
function inCell(f: Fixture, name: string, content: string): string {
  writeFileSync(path.join(f.taskDir, name), content)
  return `/workspace/${name}`
}

function outboxDir(f: Fixture): string {
  return path.join(f.outboxRoot, CELL_ID)
}

describe('publish：递出来', () => {
  it('白名单里的后缀：复制进交付格，并且真的被打开了', async () => {
    const f = fixture()
    const content = 'PNG-but-actually-text'
    const cellPath = inCell(f, 'chart.png', content)

    const result = await f.service.publish(f.session, cellPath)

    expect(result.ok).toBe(true)
    const target = path.join(outboxDir(f), 'chart.png')
    expect(existsSync(target)).toBe(true)
    // 逐字节相同，哈希与舱内的 sha256 一致（验收要的就是这条）。
    expect(readFileSync(target, 'utf8')).toBe(content)
    expect(createHash('sha256').update(content).digest('hex')).toBe(
      f.ledger.records[0]?.sha256,
    )
    expect(result.message).toContain(createHash('sha256').update(content).digest('hex'))
    expect(f.opener.calls).toEqual([`open:${target}`])

    const line = f.ledger.records[0]
    expect(line).toMatchObject({
      action: 'publish',
      outcome: 'opened',
      cellId: CELL_ID,
      agentId: 'claude',
      cellPath,
      hostPath: target,
      fileName: 'chart.png',
      extension: 'png',
      disposition: 'open',
      opened: true,
      openedWith: 'stub-opener',
      ts: FIXED_TIME.toISOString(),
    })
  })

  it('没有后缀的文件：**不打开**，只在文件夹里显示', async () => {
    const f = fixture()
    const cellPath = inCell(f, 'tool', '#!/bin/sh\nrm -rf /')

    const result = await f.service.publish(f.session, cellPath)

    expect(result.ok).toBe(true)
    // 它确实被递出来了（东西是用户的），但没有任何东西执行它。
    expect(existsSync(path.join(outboxDir(f), 'tool'))).toBe(true)
    expect(f.opener.calls).toEqual([`reveal:${outboxDir(f)}/tool`])
    expect(f.ledger.records[0]).toMatchObject({ outcome: 'revealed', opened: false, extension: '' })
    expect(result.message).toContain('没有自动打开')
    expect(result.message).toContain('没有后缀')
  })

  it('.sh：**不打开**，理由点名「在宿主上执行舱内的代码」', async () => {
    const f = fixture()
    const cellPath = inCell(f, 'setup.sh', 'echo hi')

    const result = await f.service.publish(f.session, cellPath)

    expect(f.opener.calls).toEqual([`reveal:${outboxDir(f)}/setup.sh`])
    expect(f.ledger.records[0]).toMatchObject({ outcome: 'revealed', opened: false, disposition: 'reveal' })
    expect(result.message).toContain('在**宿主上执行舱内的代码**')
  })

  it('html：只显示不打开，理由是它会跑脚本', async () => {
    const f = fixture()
    const result = await f.service.publish(f.session, inCell(f, 'report.html', '<script>fetch("http://x")</script>'))

    expect(f.opener.calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(result.message).toContain('跑脚本')
  })

  it('重名：第二次递同一个名字会改名，第一份不动', async () => {
    const f = fixture()
    const first = inCell(f, 'a.png', 'first')
    // 同名、不同目录：舱内两张图都叫 `a.png`，这在 agent 那儿很常见。
    mkdirSync(path.join(f.taskDir, 'sub'))
    writeFileSync(path.join(f.taskDir, 'sub', 'a.png'), 'second')

    await f.service.publish(f.session, first)
    const second = await f.service.publish(f.session, '/workspace/sub/a.png')

    expect(readFileSync(path.join(outboxDir(f), 'a.png'), 'utf8')).toBe('first')
    expect(existsSync(path.join(outboxDir(f), 'a-2.png'))).toBe(true)
    expect(second.message).toContain('重名')
    expect(f.ledger.records[1]).toMatchObject({ fileName: 'a-2.png' })
  })

  it('拒了也要记账：来源不在舱内、超限、软链逃逸各留一条 rejected', async () => {
    const f = fixture()
    const outside = path.join(path.dirname(f.taskDir), 'host-secret.txt')
    writeFileSync(outside, 'host only')
    symlinkSync(outside, path.join(f.taskDir, 'leak.txt'))

    const cases = [
      { cellPath: '/etc/passwd', expect: '不在这次会话的舱内目录里' },
      { cellPath: '/workspace/leak.txt', expect: '解析软链之后落在了会话目录之外' },
      { cellPath: 'relative.png', expect: '绝对路径' },
    ]
    for (const item of cases) {
      const result = await f.service.publish(f.session, item.cellPath)
      expect(result.ok, item.cellPath).toBe(false)
      expect(result.message, item.cellPath).toContain(item.expect)
    }
    expect(f.opener.calls).toEqual([])
    expect(f.ledger.records).toHaveLength(cases.length)
    for (const line of f.ledger.records) {
      expect(line.outcome).toBe('rejected')
      expect(line.opened).toBe(false)
      expect(line.reason).not.toBeNull()
    }
  })

  it('超限的文件：拒绝，理由说清多大、上限多少、为什么不截断', async () => {
    const f = fixture()
    const big = path.join(f.taskDir, 'big.pdf')
    writeFileSync(big, '')
    // 稀疏文件：报告的大小是真的，磁盘上不占那么大。
    const { truncateSync } = await import('node:fs')
    truncateSync(big, 70 * 1024 * 1024)

    const result = await f.service.publish(f.session, '/workspace/big.pdf')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('70.0 MiB')
    expect(result.message).toContain('64.0 MiB')
    expect(result.message).toContain('不会被截断')
    expect(existsSync(path.join(outboxDir(f), 'big.pdf'))).toBe(false)
  })

  it('宿主上打不开（没有打开命令）时，交付照样成功——文件是用户的', async () => {
    const f = fixture({ opener: null })
    const result = await f.service.publish(f.session, inCell(f, 'a.png', 'x'))

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(outboxDir(f), 'a.png'))).toBe(true)
    expect(result.message).toContain('没能打开')
    expect(f.ledger.records[0]).toMatchObject({ outcome: 'delivered', opened: false, openedWith: null })
  })

  it('打开命令自己失败时也一样：交付不动，失败写进账里', async () => {
    const f = fixture({ opener: failingOpener('宿主上找不到 xdg-open') })
    const result = await f.service.publish(f.session, inCell(f, 'a.png', 'x'))

    expect(result.ok).toBe(true)
    expect(result.message).toContain('宿主上找不到 xdg-open')
    expect(f.ledger.records[0]).toMatchObject({ outcome: 'delivered', opened: false })
  })

  it('账写不下来 → 交付被撤销，并且明说为什么', async () => {
    const f = fixture()
    f.ledger.failNextWith(new Error('磁盘满了'))

    const result = await f.service.publish(f.session, inCell(f, 'report.pdf', 'x'))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('审计')
    expect(result.message).toContain('磁盘满了')
    // 交付格里不能留下一个没有任何账目对应的文件。
    expect(existsSync(path.join(outboxDir(f), 'report.pdf'))).toBe(false)
    expect(f.ledger.records).toHaveLength(0)
  })
})

describe('open：打开已经交付过的那一份', () => {
  it('打开交付格里的文件', async () => {
    const f = fixture()
    await f.service.publish(f.session, inCell(f, 'chart.png', 'x'))
    f.opener.calls.length = 0

    const result = await f.service.open(f.session, 'chart.png')

    expect(result.ok).toBe(true)
    expect(f.opener.calls).toEqual([`open:${path.join(outboxDir(f), 'chart.png')}`])
    expect(f.ledger.records[1]).toMatchObject({ action: 'open', outcome: 'opened', opened: true })
  })

  it('**同一个白名单管着 open**：先递 .sh 再 open 它，照样不执行', async () => {
    // 少了这一条，两步就能绕过整道闸：publish 判一次、open 再放行。
    const f = fixture()
    await f.service.publish(f.session, inCell(f, 'setup.sh', 'echo hi'))
    f.opener.calls.length = 0

    const result = await f.service.open(f.session, 'setup.sh')

    expect(f.opener.calls).toEqual([`reveal:${path.join(outboxDir(f), 'setup.sh')}`])
    expect(result.message).toContain('没有打开')
    expect(f.ledger.records[1]).toMatchObject({ action: 'open', outcome: 'revealed', opened: false })
  })

  it('只收文件名：带路径的一律拒，而且不做「顺手 basename」', async () => {
    const f = fixture()
    for (const name of ['/etc/passwd', '../../etc/passwd', 'a/b.png', '..', '']) {
      const result = await f.service.open(f.session, name)
      expect(result.ok, name).toBe(false)
    }
    expect(f.opener.calls).toEqual([])
  })

  it('文件不在交付格里：拒，并列出里面有什么', async () => {
    const f = fixture()
    await f.service.publish(f.session, inCell(f, 'chart.png', 'x'))

    const missing = await f.service.open(f.session, 'nope.png')
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('不在这次的交付格里')
    expect(missing.message).toContain('chart.png')

    const empty = fixture()
    const nothing = await empty.service.open(empty.session, 'chart.png')
    expect(nothing.message).toContain('还是空的')
    expect(empty.ledger.records[0]).toMatchObject({ outcome: 'rejected' })
  })

  it('另一个会话的交付格是另一个目录：cellId 不同就打不开', async () => {
    // 「交付窗」按会话分格，这条是它的直接后果——也是它存在的理由：
    // 舱内那个 agent 只能看见自己这次会话递出来的东西。
    const f = fixture()
    await f.service.publish(f.session, inCell(f, 'chart.png', 'x'))

    const other: TransomSession = { ...f.session, cellId: 'claude-20261023-other' }
    const result = await f.service.open(other, 'chart.png')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('还是空的')
  })
})

describe('交付格本身不会被舱内改写', () => {
  it('交付格只读之后，交付失败得有理由，而不是静默成功', async () => {
    const f = fixture()
    const cellPath = inCell(f, 'a.png', 'x')
    mkdirSync(outboxDir(f), { recursive: true })
    chmodSync(outboxDir(f), 0o500)

    try {
      const result = await f.service.publish(f.session, cellPath)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('写不进交付格')
    } finally {
      chmodSync(outboxDir(f), 0o700)
    }
  })
})
