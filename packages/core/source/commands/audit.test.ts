import { describe, expect, it } from 'vitest'
import { formatRecord } from './audit'

const RECORD = {
  ts: '2026-10-23T10:20:30.000Z',
  cellId: 'claude-1',
  method: 'POST',
  path: '/u/anthropic/v1/messages',
  upstreamId: 'anthropic',
  targetHost: 'api.anthropic.com',
  decision: 'allowed',
  status: 200,
  durationMs: 42.4,
  credentialInjected: true,
  face: 'cell',
}

describe('formatRecord', () => {
  it('一行一条，带时间、决策、状态码、耗时、面、是否注入', () => {
    const line = formatRecord(JSON.stringify(RECORD))
    expect(line).toContain('2026-10-23 10:20:30.000')
    expect(line).toContain('allowed')
    expect(line).toContain('200')
    expect(line).toContain('42ms')
    expect(line).toContain('cell')
    expect(line).toContain('注入')
    expect(line).toContain('POST /u/anthropic/v1/messages')
    expect(line).toContain('api.anthropic.com')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('没有注入时明确画一条横杠，不是空白', () => {
    const line = formatRecord(JSON.stringify({ ...RECORD, credentialInjected: false }))
    expect(line).toContain('—')
    expect(line).not.toContain('注入')
  })

  it('拒绝的记录同样显示得出来', () => {
    const line = formatRecord(
      JSON.stringify({ ...RECORD, decision: 'denied-egress', status: 403, credentialInjected: false }),
    )
    expect(line).toContain('denied-egress')
    expect(line).toContain('403')
  })

  it('解析不了的一行原样显示，不吞掉', () => {
    // 审计文件是可追加的纯文本，写到一半被 kill 掉会留下半行。
    const line = formatRecord('{"ts":"2026-10-23T10:20')
    expect(line).toContain('无法解析')
    expect(line).toContain('{"ts"')
  })

  it('字段缺失时不抛', () => {
    expect(() => formatRecord('{}')).not.toThrow()
  })

  it('目标缺失时退到上游 id，再退到横杠', () => {
    expect(formatRecord(JSON.stringify({ ...RECORD, targetHost: null }))).toContain('anthropic')
    expect(formatRecord(JSON.stringify({ ...RECORD, targetHost: null, upstreamId: null }))).toContain('→ -')
  })

  it('输出里不会出现 authorization 这类字段', () => {
    // 审计记录本来就没有这个字段；这一层要保证的是「别把它加回来」。
    const line = formatRecord(JSON.stringify({ ...RECORD, authorization: 'Bearer sk-ant-real' }))
    expect(line).not.toContain('sk-ant-real')
    expect(line).not.toContain('authorization')
  })
})
