import { describe, expect, it } from 'vitest'
import { buildOutboundHeaders, pickTransport } from './forward'
import https from 'node:https'
import http from 'node:http'

const ORIGIN = new URL('https://api.anthropic.com')

describe('buildOutboundHeaders', () => {
  it('注入时用真实密钥覆盖认证头', () => {
    const headers = buildOutboundHeaders(
      { authorization: 'Bearer abx-placeholder-anthropic', 'content-type': 'application/json' },
      ORIGIN,
      { header: 'authorization', value: 'Bearer real-secret' },
    )
    expect(headers['authorization']).toBe('Bearer real-secret')
    expect(headers['content-type']).toBe('application/json')
  })

  it('占位符的大小写变体也照样被覆盖', () => {
    // Node 会把进来的头名统一小写，但这里仍然显式验证一遍：
    // 「无条件覆盖」是这套代理的核心承诺。
    const headers = buildOutboundHeaders(
      { Authorization: 'Bearer abx-placeholder-anthropic' },
      ORIGIN,
      { header: 'authorization', value: 'Bearer real-secret' },
    )
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization')).toHaveLength(1)
    expect(headers['authorization']).toBe('Bearer real-secret')
  })

  it('不注入时把所有像凭据的头都剥掉', () => {
    const headers = buildOutboundHeaders(
      {
        authorization: 'Bearer placeholder',
        'x-api-key': 'placeholder',
        'api-key': 'placeholder',
        'x-goog-api-key': 'placeholder',
        'proxy-authorization': 'placeholder',
        'content-type': 'application/json',
      },
      ORIGIN,
      null,
    )
    expect(headers['authorization']).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['api-key']).toBeUndefined()
    expect(headers['x-goog-api-key']).toBeUndefined()
    expect(headers['proxy-authorization']).toBeUndefined()
    expect(headers['content-type']).toBe('application/json')
  })

  it('只配了 authorization 时，舱内另发一个 x-api-key 也不会漏出去', () => {
    // 只按配置里那一个头名清理是不够的：舱内完全可以发一个别的名字。
    const headers = buildOutboundHeaders({ 'x-api-key': 'placeholder' }, ORIGIN, {
      header: 'authorization',
      value: 'Bearer real-secret',
    })
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['authorization']).toBe('Bearer real-secret')
  })

  it('逐跳头被丢掉', () => {
    const headers = buildOutboundHeaders(
      {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        trailer: 'x-foo',
        'proxy-connection': 'keep-alive',
        'content-type': 'text/plain',
      },
      ORIGIN,
      null,
    )
    expect(headers['connection']).toBeUndefined()
    expect(headers['keep-alive']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
    expect(headers['upgrade']).toBeUndefined()
    expect(headers['te']).toBeUndefined()
    expect(headers['trailer']).toBeUndefined()
    expect(headers['proxy-connection']).toBeUndefined()
    expect(headers['content-type']).toBe('text/plain')
  })

  it('host 重写成目标 host（含非默认端口）', () => {
    expect(buildOutboundHeaders({ host: 'broker.local:8789' }, ORIGIN, null)['host']).toBe('api.anthropic.com')
    expect(
      buildOutboundHeaders({ host: 'x' }, new URL('http://127.0.0.1:9000'), null)['host'],
    ).toBe('127.0.0.1:9000')
  })

  it('x-abx-* 控制面头不会流到外面', () => {
    const headers = buildOutboundHeaders(
      { 'x-abx-target': 'https://evil.example.net', 'x-abx-cell': 'secret-token', 'x-abx-cell-id': 'c1' },
      ORIGIN,
      null,
    )
    expect(Object.keys(headers).filter((name) => name.startsWith('x-abx-'))).toEqual([])
  })

  it('无关的头原样保留，数组值也不拆', () => {
    const headers = buildOutboundHeaders({ 'x-multi': ['a', 'b'], accept: '*/*' }, ORIGIN, null)
    expect(headers['x-multi']).toEqual(['a', 'b'])
    expect(headers['accept']).toBe('*/*')
  })

  it('值为 undefined 的头被跳过，不会写出字符串 "undefined"', () => {
    const headers = buildOutboundHeaders({ 'x-thing': undefined }, ORIGIN, null)
    expect(headers['x-thing']).toBeUndefined()
  })
})

describe('pickTransport', () => {
  it('http 与 https 各走各的', () => {
    expect(pickTransport('http:')).toBe(http)
    expect(pickTransport('https:')).toBe(https)
  })
})
