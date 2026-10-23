import { describe, expect, it } from 'vitest'
import type { EgressRule, Upstream } from '@abx/contracts'
import { buildUpstreamIndex, evaluateEgress, upstreamForHost } from './egress'

function rule(pattern: string, upstreamId: string | null = null): EgressRule {
  return { pattern, upstreamId }
}

function upstream(id: string, baseUrl: string): Upstream {
  return {
    id,
    baseUrl,
    authHeader: 'authorization',
    authScheme: 'Bearer',
    secretEnv: `${id.toUpperCase()}_API_KEY`,
    secretFile: null,
  }
}

describe('evaluateEgress', () => {
  it('命中白名单就放行，并给出命中的模式', () => {
    const decision = evaluateEgress('api.anthropic.com', [rule('api.anthropic.com', 'anthropic')])
    expect(decision).toEqual({ allowed: true, pattern: 'api.anthropic.com', upstreamId: 'anthropic' })
  })

  it('不在白名单就拒绝', () => {
    const decision = evaluateEgress('evil.example.net', [rule('api.anthropic.com')])
    expect(decision).toEqual({ allowed: false, reason: 'not-allowlisted', host: 'evil.example.net' })
  })

  it('空白名单拒绝一切', () => {
    expect(evaluateEgress('api.anthropic.com', []).allowed).toBe(false)
  })

  it('先命中的规则先生效', () => {
    const allowlist = [rule('.example.com', 'broad'), rule('api.example.com', 'narrow')]
    const decision = evaluateEgress('api.example.com', allowlist)
    expect(decision).toEqual({ allowed: true, pattern: '.example.com', upstreamId: 'broad' })
  })

  it('顺序调过来就是另一条生效', () => {
    const allowlist = [rule('api.example.com', 'narrow'), rule('.example.com', 'broad')]
    const decision = evaluateEgress('api.example.com', allowlist)
    expect(decision).toEqual({ allowed: true, pattern: 'api.example.com', upstreamId: 'narrow' })
  })

  it('匹配前先归一化请求里的 host', () => {
    const allowlist = [rule('api.anthropic.com')]
    expect(evaluateEgress('API.Anthropic.com:443', allowlist).allowed).toBe(true)
    expect(evaluateEgress('api.anthropic.com.', allowlist).allowed).toBe(true)
  })

  it('空 host 拒绝', () => {
    expect(evaluateEgress('', [rule('.example.com')]).allowed).toBe(false)
  })

  it('通配规则不会漏掉前缀相似的域名', () => {
    const allowlist = [rule('*.example.com')]
    expect(evaluateEgress('api.example.com', allowlist).allowed).toBe(true)
    expect(evaluateEgress('notexample.com', allowlist).allowed).toBe(false)
    expect(evaluateEgress('example.com', allowlist).allowed).toBe(false)
  })

  it('直通规则（不绑上游）放行但 upstreamId 为 null', () => {
    const decision = evaluateEgress('cdn.example.com', [rule('*.example.com')])
    expect(decision).toEqual({ allowed: true, pattern: '*.example.com', upstreamId: null })
  })
})

describe('buildUpstreamIndex', () => {
  it('按 baseUrl 的 host 建索引', () => {
    const index = buildUpstreamIndex([upstream('anthropic', 'https://api.anthropic.com')])
    expect(upstreamForHost(index, 'api.anthropic.com')?.id).toBe('anthropic')
    expect(upstreamForHost(index, 'API.ANTHROPIC.COM:443')?.id).toBe('anthropic')
  })

  it('按 id 建索引', () => {
    const index = buildUpstreamIndex([upstream('anthropic', 'https://api.anthropic.com')])
    expect(index.byId.get('anthropic')?.baseUrl).toBe('https://api.anthropic.com')
  })

  it('没配过的 host 返回 null', () => {
    const index = buildUpstreamIndex([upstream('anthropic', 'https://api.anthropic.com')])
    expect(upstreamForHost(index, 'api.openai.com')).toBeNull()
  })

  it('host 相同时保留先出现的那个', () => {
    const index = buildUpstreamIndex([
      upstream('first', 'https://api.example.com'),
      upstream('second', 'https://api.example.com/v2'),
    ])
    expect(upstreamForHost(index, 'api.example.com')?.id).toBe('first')
    expect(index.byId.get('second')?.id).toBe('second')
  })

  it('baseUrl 解析不了的上游不进索引，但仍在 byId 里', () => {
    const index = buildUpstreamIndex([upstream('broken', 'not a url')])
    expect(index.byHost.size).toBe(0)
    expect(index.byId.has('broken')).toBe(true)
  })
})
