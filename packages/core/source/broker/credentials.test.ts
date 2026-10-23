import { describe, expect, it } from 'vitest'
import { makeUpstream } from '@abx/contracts/test-support'
import {
  SecretValue,
  buildAuthHeaderValue,
  collectSecretEnvNames,
  resolveUpstreamSecret,
  safeEqual,
} from './credentials'

/** 只在这个文件里存在的假密钥。用来验证「它绝不会出现在输出里」。 */
const FAKE_SECRET = 'sk-ant-FAKE-0000000000000000000000000000'

const deps = {
  env: { ANTHROPIC_API_KEY: FAKE_SECRET, EMPTY_KEY: '   ' },
  readFile: (path: string) => {
    if (path === '/run/secrets/anthropic') return `${FAKE_SECRET}\n`
    if (path === '/run/secrets/empty') return '\n'
    throw new Error('ENOENT')
  },
}

describe('SecretValue', () => {
  it('reveal() 拿得到真值', () => {
    expect(new SecretValue(FAKE_SECRET).reveal()).toBe(FAKE_SECRET)
  })

  it('模板字符串里不会漏', () => {
    // 这一条是这套机制存在的全部理由：最常见的泄漏方式就是拼日志时顺手写了 ${secret}。
    const secret = new SecretValue(FAKE_SECRET)
    expect(`token=${secret}`).toBe('token=[abx:secret]')
    expect(`token=${secret}`).not.toContain(FAKE_SECRET)
  })

  it('JSON.stringify 不会漏', () => {
    const secret = new SecretValue(FAKE_SECRET)
    expect(JSON.stringify({ authorization: secret })).toBe('{"authorization":"[abx:secret]"}')
    expect(JSON.stringify({ nested: { deep: [secret] } })).not.toContain(FAKE_SECRET)
  })

  it('util.inspect 不会漏（console.log 走的是这条）', async () => {
    const { inspect } = await import('node:util')
    const secret = new SecretValue(FAKE_SECRET)
    expect(inspect({ secret })).not.toContain(FAKE_SECRET)
  })

  it('length 可以看，用来排查「密钥是空的」', () => {
    expect(new SecretValue(FAKE_SECRET).length).toBe(FAKE_SECRET.length)
  })

  it('抛错时不会漏', () => {
    const secret = new SecretValue(FAKE_SECRET)
    const error = new Error(`上游拒绝了 ${secret}`)
    expect(error.message).not.toContain(FAKE_SECRET)
  })
})

describe('resolveUpstreamSecret', () => {
  it('从环境变量读，并去掉首尾空白', () => {
    const upstream = makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: 'ANTHROPIC_API_KEY' })
    const result = resolveUpstreamSecret(upstream, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.secret.reveal()).toBe(FAKE_SECRET)
    expect(result.source).toBe('env')
    expect(result.reference).toBe('ANTHROPIC_API_KEY')
  })

  it('从文件读', () => {
    const upstream = makeUpstream({
      id: 'a',
      baseUrl: 'https://a.example.com',
      secretEnv: null,
      secretFile: '/run/secrets/anthropic',
    })
    const result = resolveUpstreamSecret(upstream, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.secret.reveal()).toBe(FAKE_SECRET)
    expect(result.source).toBe('file')
  })

  it('环境变量没设置时明确说是没设置', () => {
    const upstream = makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: 'NOT_SET_ANYWHERE' })
    const result = resolveUpstreamSecret(upstream, deps)
    expect(result).toMatchObject({ ok: false, reason: 'env-missing', reference: 'NOT_SET_ANYWHERE' })
  })

  it('环境变量是空白时算空，不算「没设置」', () => {
    const upstream = makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: 'EMPTY_KEY' })
    const result = resolveUpstreamSecret(upstream, deps)
    expect(result).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('文件读不到时给出原因，且不含文件内容', () => {
    const upstream = makeUpstream({
      id: 'a',
      baseUrl: 'https://a.example.com',
      secretEnv: null,
      secretFile: '/run/secrets/nope',
    })
    const result = resolveUpstreamSecret(upstream, deps)
    expect(result).toMatchObject({ ok: false, reason: 'file-unreadable' })
    if (result.ok) return
    expect(result.detail).toContain('ENOENT')
  })

  it('文件是空的也算空', () => {
    const upstream = makeUpstream({
      id: 'a',
      baseUrl: 'https://a.example.com',
      secretEnv: null,
      secretFile: '/run/secrets/empty',
    })
    expect(resolveUpstreamSecret(upstream, deps)).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('既没有 secretEnv 也没有 secretFile 时拒绝，而不是给一个空密钥', () => {
    const upstream = makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: null, secretFile: null })
    expect(resolveUpstreamSecret(upstream, deps).ok).toBe(false)
  })

  it('失败结果里不含密钥内容', () => {
    const upstream = makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: 'EMPTY_KEY' })
    const result = resolveUpstreamSecret(upstream, deps)
    if (result.ok) throw new Error('这个用例要求解析失败')
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET)
  })
})

describe('buildAuthHeaderValue', () => {
  it('拼上 scheme', () => {
    expect(buildAuthHeaderValue('Bearer', new SecretValue('abc'))).toBe('Bearer abc')
  })

  it('没有 scheme 时是裸密钥', () => {
    expect(buildAuthHeaderValue(null, new SecretValue('abc'))).toBe('abc')
  })

  it('空串 scheme 按没有处理', () => {
    // 配置里一个看不见的空格不该拼出 `" abc"` 这种头。
    expect(buildAuthHeaderValue('  ', new SecretValue('abc'))).toBe('abc')
    expect(buildAuthHeaderValue('', new SecretValue('abc'))).toBe('abc')
  })

  it('scheme 前后空白被去掉', () => {
    expect(buildAuthHeaderValue(' Bearer ', new SecretValue('abc'))).toBe('Bearer abc')
  })
})

describe('collectSecretEnvNames', () => {
  it('只收环境变量名，不收文件路径', () => {
    const names = collectSecretEnvNames([
      makeUpstream({ id: 'a', baseUrl: 'https://a.example.com', secretEnv: 'A_KEY' }),
      makeUpstream({ id: 'b', baseUrl: 'https://b.example.com', secretEnv: null, secretFile: '/run/secrets/b' }),
      makeUpstream({ id: 'c', baseUrl: 'https://c.example.com', secretEnv: 'C_KEY' }),
    ])
    expect(names).toEqual(['A_KEY', 'C_KEY'])
  })

  it('空配置给空数组', () => {
    expect(collectSecretEnvNames([])).toEqual([])
  })
})

describe('safeEqual', () => {
  it('相等为真', () => {
    expect(safeEqual('token-abc', 'token-abc')).toBe(true)
  })

  it('不等为假', () => {
    expect(safeEqual('token-abc', 'token-abd')).toBe(false)
  })

  it('长度不同为假', () => {
    expect(safeEqual('token-abc', 'token-abc-longer')).toBe(false)
  })

  it('空串相等为真，但与空串之外都为假', () => {
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('', 'x')).toBe(false)
  })

  it('多字节字符不会因为 Buffer 长度判断错', () => {
    expect(safeEqual('令牌', '令牌')).toBe(true)
    expect(safeEqual('令牌', '令排')).toBe(false)
  })
})
