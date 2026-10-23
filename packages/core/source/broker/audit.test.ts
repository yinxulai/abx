import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileAuditSink, createMemoryAuditSink, sanitizeField, toAuditLine, type AuditRecord } from './audit'

const FAKE_SECRET = 'sk-ant-FAKE-1111111111111111111111111111'

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: '2026-10-23T00:00:00.000Z',
    cellId: 'cell-1',
    sourceAddress: '192.168.65.2',
    method: 'POST',
    path: '/u/anthropic/v1/messages',
    upstreamId: 'anthropic',
    targetHost: 'api.anthropic.com',
    decision: 'allowed',
    status: 200,
    durationMs: 12.7,
    credentialInjected: true,
    face: 'cell',
    ...overrides,
  }
}

describe('toAuditLine', () => {
  it('字段齐全，一行一个 JSON 对象', () => {
    const parsed = JSON.parse(toAuditLine(record())) as Record<string, unknown>
    expect(parsed).toEqual({
      ts: '2026-10-23T00:00:00.000Z',
      cellId: 'cell-1',
      sourceAddress: '192.168.65.2',
      method: 'POST',
      path: '/u/anthropic/v1/messages',
      upstreamId: 'anthropic',
      targetHost: 'api.anthropic.com',
      decision: 'allowed',
      status: 200,
      durationMs: 13,
      credentialInjected: true,
      face: 'cell',
    })
  })

  it('durationMs 取整，不写小数', () => {
    const parsed = JSON.parse(toAuditLine(record({ durationMs: 3.4 }))) as { durationMs: number }
    expect(parsed.durationMs).toBe(3)
  })

  it('永远不包含 authorization —— 记录里根本没有这个字段', () => {
    // 就算调用方往对象上挂了 authorization，白名单取值也序列化不出来。
    const hostile = { ...record(), authorization: `Bearer ${FAKE_SECRET}` } as AuditRecord
    const line = toAuditLine(hostile)
    expect(line).not.toContain('authorization')
    expect(line).not.toContain(FAKE_SECRET)
  })

  it('注入成功与否只记布尔值', () => {
    expect(JSON.parse(toAuditLine(record({ credentialInjected: false })))).toMatchObject({
      credentialInjected: false,
    })
  })

  it('上游 id / 目标 / 来源为空时写 null，不写 undefined', () => {
    const parsed = JSON.parse(
      toAuditLine(record({ upstreamId: null, targetHost: null, sourceAddress: null })),
    ) as Record<string, unknown>
    expect(parsed['upstreamId']).toBeNull()
    expect(parsed['targetHost']).toBeNull()
    expect(parsed['sourceAddress']).toBeNull()
    // undefined 会被 JSON.stringify 直接丢掉，字段就消失了——审计的字段应当固定。
    expect(Object.keys(parsed)).toContain('targetHost')
    expect(Object.keys(parsed)).toContain('sourceAddress')
  })

  it('来源地址也是外部输入，同样要压成一行里的安全字段', () => {
    const line = toAuditLine(record({ sourceAddress: '1.2.3.4\n{"decision":"allowed"}' }))
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('\\n')
  })

  it('每一次决策都有对应的取值', () => {
    for (const decision of [
      'allowed',
      'denied-egress',
      'denied-cell-source',
      'denied-cell-token',
      'denied-cell-identity',
      'denied-route',
      'denied-unknown-upstream',
      'credential-missing',
      'upstream-error',
      'upstream-timeout',
    ] as const) {
      expect(JSON.parse(toAuditLine(record({ decision })))).toMatchObject({ decision })
    }
  })
})

describe('sanitizeField', () => {
  it('换行被转义，一行日志不会被撑成两行', () => {
    // 不转义的话，`GET /a%0A{"decision":"allowed"}` 能在审计文件里凭空造一行。
    const line = toAuditLine(record({ path: '/a\n{"decision":"allowed"}' }))
    expect(line.split('\n')).toHaveLength(1)
    expect(line).not.toContain('\n')
    expect(line).toContain('\\n')
  })

  it('回车、制表符、反斜杠都被转义', () => {
    expect(sanitizeField('a\rb\tc\\d')).toBe('a\\rb\\tc\\\\d')
  })

  it('其他控制字符转成 \\xNN', () => {
    expect(sanitizeField('a\u0000b\u001fc')).toBe('a\\x00b\\x1fc')
  })

  it('超长字段被截断，并标出截断', () => {
    const long = 'a'.repeat(50)
    const result = sanitizeField(long, 10)
    expect(result).toContain('…[truncated 40]')
    expect(result.startsWith('aaaaaaaaaa')).toBe(true)
  })

  it('普通路径原样保留', () => {
    expect(sanitizeField('/v1/messages?beta=true')).toBe('/v1/messages?beta=true')
  })
})

describe('createMemoryAuditSink', () => {
  it('留下记录和文本两份', async () => {
    const sink = createMemoryAuditSink()
    await sink.write(record())
    await sink.write(record({ decision: 'denied-egress', status: 403 }))
    expect(sink.records).toHaveLength(2)
    expect(sink.lines).toHaveLength(2)
    expect(JSON.parse(sink.lines[1] ?? '')).toMatchObject({ decision: 'denied-egress', status: 403 })
  })
})

describe('createFileAuditSink', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  function tempDir(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-audit-'))
    directories.push(directory)
    return directory
  }

  function tempFile(): string {
    return path.join(tempDir(), 'nested', 'audit.jsonl')
  }

  it('追加写，目录不存在时自己建', async () => {
    const file = tempFile()
    const sink = createFileAuditSink(file)
    await sink.write(record())
    await sink.write(record({ decision: 'denied-egress', status: 403 }))
    await sink.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ decision: 'denied-egress' })
  })

  it('并发写入不会把两条记录交错成半行', async () => {
    // appendFile 并发调用不保证整行原子，串行化是为了这个。
    const file = tempFile()
    const sink = createFileAuditSink(file)
    await Promise.all(Array.from({ length: 50 }, (_, index) => sink.write(record({ cellId: `cell-${index}` }))))
    await sink.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(50)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('落盘内容里没有密钥', async () => {
    const file = tempFile()
    const sink = createFileAuditSink(file)
    const hostile = { ...record(), authorization: `Bearer ${FAKE_SECRET}` } as AuditRecord
    await sink.write(hostile)
    await sink.close()

    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(FAKE_SECRET)
    expect(text).not.toContain('authorization')
  })

  it('文件是追加而不是覆盖', async () => {
    const file = tempFile()
    const first = createFileAuditSink(file)
    await first.write(record({ cellId: 'before-restart' }))
    await first.close()

    const second = createFileAuditSink(file)
    await second.write(record({ cellId: 'after-restart' }))
    await second.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('before-restart')
    expect(lines[1]).toContain('after-restart')
  })

  it('**一条都没写过**时，建不出审计文件也不许变成未处理的 rejection', async () => {
    // 建目录是构造时起跑的，而唯一 await 它的地方是 write。broker 完全可能一个
    // 审计条目都不产生（只探活），那时没人接住那个失败——node 默认会因此终止进程，
    // 而「审计文件建不出来」该有的表现是「第一次要写的时候写不进去」。
    const blocked = path.join(tempDir(), 'blocked')
    writeFileSync(blocked, 'x')

    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sink = createFileAuditSink(path.join(blocked, 'audit.jsonl'))
      // 未处理的 rejection 是在这一轮跑完之后才判定的，所以给它几个回合。
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(seen).toEqual([])
      // 失败没有被吞掉：真要写的时候照样走到「写不进去」那一步（这里只是不抛给
      // 调用方——broker 的审计 sink 是「写失败不阻断请求」，它记在 stderr 上）。
      await expect(sink.write(record())).resolves.toBeUndefined()
      expect(sink.describe).toContain('audit.jsonl')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
