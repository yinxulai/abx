/**
 * 账本的用例。
 *
 * 两组：一组是**形状**（每条记录里该有的字段都在、不该在的一个都没有），
 * 一组是**契约**（写不进去就抛——调用方据此把交付撤掉；以及一份账里不能出现令牌）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNNING_VOCABULARY } from '../test-support'
import {
  TRANSOM_LEDGER_ENV,
  createFileTransomLedger,
  createMemoryTransomLedger,
  defaultTransomLedgerPath,
  toTransomLine,
  type TransomRecord,
} from './ledger'

/** 账本的落点是**宿主路径**，形状跟着跑测试这台机器走（见 `test-support.ts`）。 */
const HOST = RUNNING_VOCABULARY

const directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'abx-ledger-'))
  directories.push(directory)
  return directory
}

function record(overrides: Partial<TransomRecord> = {}): TransomRecord {
  return {
    ts: '2026-10-23T12:00:00.000Z',
    cellId: 'claude-20261023-abcdef',
    agentId: 'claude',
    action: 'publish',
    outcome: 'opened',
    cellPath: '/workspace/report.pdf',
    hostPath: '/home/dev/.abx/outbox/claude-20261023-abcdef/report.pdf',
    fileName: 'report.pdf',
    extension: 'pdf',
    bytes: 20480,
    sha256: 'a'.repeat(64),
    disposition: 'open',
    opened: true,
    openedWith: 'open',
    reason: null,
    ...overrides,
  }
}

describe('账本的落点', () => {
  it('默认在 ~/.abx/transom.jsonl，**不在**交付格里面', () => {
    const file = defaultTransomLedgerPath({}, HOST.home)
    expect(file).toBe(HOST.underHome('.abx', 'transom.jsonl'))
    // 交付格里 `ls` 出来的每一项都该是用户能打开的文件。
    expect(file.startsWith(HOST.underHome('.abx', 'outbox') + HOST.rules.path.sep)).toBe(false)
  })

  it('环境变量能覆盖，而且跟着交付根走', () => {
    const elsewhere = HOST.underHome('elsewhere')
    const custom = HOST.join(elsewhere, 'x.jsonl')
    expect(defaultTransomLedgerPath({ [TRANSOM_LEDGER_ENV]: custom }, HOST.home)).toBe(custom)
    expect(defaultTransomLedgerPath({ ABX_OUTBOX_ROOT: HOST.join(elsewhere, 'outbox') }, HOST.home)).toBe(
      HOST.join(elsewhere, 'transom.jsonl'),
    )
  })
})

describe('一条记录里的字段', () => {
  it('该有的都在：谁、什么时候、递了什么、落到哪儿、多大、什么哈希、打开没有', () => {
    const line = JSON.parse(toTransomLine(record())) as Record<string, unknown>
    expect(line).toEqual({
      ts: '2026-10-23T12:00:00.000Z',
      cellId: 'claude-20261023-abcdef',
      agentId: 'claude',
      action: 'publish',
      outcome: 'opened',
      cellPath: '/workspace/report.pdf',
      hostPath: '/home/dev/.abx/outbox/claude-20261023-abcdef/report.pdf',
      fileName: 'report.pdf',
      extension: 'pdf',
      bytes: 20480,
      sha256: 'a'.repeat(64),
      disposition: 'open',
      opened: true,
      openedWith: 'open',
      reason: null,
    })
  })

  it('递出来了但没打开，是可分辨的一种结果（不是「失败」）', () => {
    const line = JSON.parse(
      toTransomLine(
        record({
          cellPath: '/workspace/setup.sh',
          fileName: 'setup.sh',
          extension: 'sh',
          disposition: 'reveal',
          outcome: 'revealed',
          opened: false,
          openedWith: null,
          reason: '.sh 是可执行文件或安装包：用默认应用打开它就是在宿主上执行舱内的代码。',
        }),
      ),
    ) as Record<string, unknown>
    expect(line.outcome).toBe('revealed')
    expect(line.opened).toBe(false)
    expect(line.openedWith).toBeNull()
    expect(String(line.reason)).toContain('可执行文件')
  })

  it('逐字段白名单：记录对象上多挂的字段写不出去', () => {
    // 「审计里不会有凭据」这条保证的落点。调用方往对象上挂什么都不算数。
    const smuggled = { ...record(), cellToken: 'abx_cell_deadbeef', authorization: 'Bearer sk-real' }
    const line = toTransomLine(smuggled)
    expect(line).not.toContain('abx_cell_deadbeef')
    expect(line).not.toContain('sk-real')
    expect(Object.keys(JSON.parse(line) as object)).not.toContain('cellToken')
  })

  it('文件名与理由里的控制字符被转义：一行就是一行', () => {
    // 文件名来自舱内，是可以被 agent 决定的东西。
    const line = toTransomLine(
      record({ fileName: 'a\nb.json', reason: '为什么\r\n拒绝' }),
    )
    expect(line.includes('\n')).toBe(false)
    expect(line.includes('\r')).toBe(false)
    const parsed = JSON.parse(line) as { fileName: string; reason: string }
    expect(parsed.fileName).toBe('a\\nb.json')
    expect(parsed.reason).toBe('为什么\\r\\n拒绝')
  })

  it('超长的路径被截断，而且明说截了', () => {
    const line = JSON.parse(toTransomLine(record({ cellPath: `/workspace/${'x'.repeat(5000)}.pdf` }))) as {
      cellPath: string
    }
    expect(line.cellPath).toContain('[truncated')
    expect(line.cellPath.length).toBeLessThan(2200)
  })
})

describe('写文件：一行一条，追加', () => {
  it('两次交付两行，顺序就是发生的顺序', async () => {
    const file = path.join(tempDir(), 'nested', 'transom.jsonl')
    const ledger = createFileTransomLedger(file)

    await ledger.write(record({ fileName: 'a.pdf' }))
    await ledger.write(record({ fileName: 'b.pdf', outcome: 'revealed', opened: false, openedWith: null }))
    await ledger.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0]!) as { fileName: string }).fileName).toBe('a.pdf')
    expect((JSON.parse(lines[1]!) as { fileName: string }).fileName).toBe('b.pdf')
    expect(ledger.describe).toBe(file)
  })

  it('并发写不会把两行搅在一起', async () => {
    const file = path.join(tempDir(), 'transom.jsonl')
    const ledger = createFileTransomLedger(file)
    await Promise.all(Array.from({ length: 20 }, (_unused, index) => ledger.write(record({ bytes: index }))))
    await ledger.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(20)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('写不进去就抛——这是「记不下来的交付不算数」的落点', async () => {
    // 路径上有一格是**文件**（不是目录），所以账本永远建不出来。
    const blocked = path.join(tempDir(), 'blocked')
    writeFileSync(blocked, 'x')
    const ledger = createFileTransomLedger(path.join(blocked, 'transom.jsonl'))

    await expect(ledger.write(record())).rejects.toThrow()
    // 坏过一次就一路抛：每条记录都去撞同一个错误，只会把「磁盘满」变成一串没人看的堆栈。
    await expect(ledger.write(record())).rejects.toThrow()
    await ledger.close()
  })

  it('**一个东西都没递**的会话里，建不出账本也不许变成未处理的 rejection', async () => {
    // 建目录是构造时起跑的，而唯一 await 它的地方是 write。一次都不写的时候，
    // 没人接住那个失败——node 默认会让它终止进程，而这次会话本来什么事都没有。
    const blocked = path.join(tempDir(), 'blocked')
    writeFileSync(blocked, 'x')

    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ledger = createFileTransomLedger(path.join(blocked, 'transom.jsonl'))
      // 未处理的 rejection 是在这一轮跑完之后才判定的，所以给它几个回合。
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(seen).toEqual([])
      // 而且失败没有被吞掉：真要写的时候照样抛。
      await expect(ledger.write(record())).rejects.toThrow()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('内存账本（用例用的那个）', () => {
  it('记下来的是记录本身，也留下可读的行', async () => {
    const ledger = createMemoryTransomLedger()
    await ledger.write(record())
    expect(ledger.records).toHaveLength(1)
    expect(ledger.lines[0]).toContain('report.pdf')
  })

  it('能让下一次写入失败：用例要验「交付被撤掉」那条路', async () => {
    const ledger = createMemoryTransomLedger()
    ledger.failNextWith(new Error('磁盘满了'))
    await expect(ledger.write(record())).rejects.toThrow('磁盘满了')
    // 只失败这一次，下一回照常。
    await expect(ledger.write(record())).resolves.toBeUndefined()
    expect(ledger.records).toHaveLength(1)
  })
})
