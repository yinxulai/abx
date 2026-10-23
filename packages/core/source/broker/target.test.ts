import { describe, expect, it } from 'vitest'
import { makeConfig, makeEgressRule, makeUpstream } from '@abx/contracts/test-support'
import type { AbxConfig } from '@abx/contracts'
import { buildUpstreamIndex } from '../policy/index'
import { concatUpstreamPath, resolveTarget } from './target'

const FAKE_SECRET = 'sk-ant-FAKE-2222222222222222222222222222'
const ENV = { ANTHROPIC_API_KEY: FAKE_SECRET }
const readFile = (): string => {
  throw new Error('ENOENT')
}

const anthropic = makeUpstream({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', secretEnv: 'ANTHROPIC_API_KEY' })

function baseConfig(overrides: Parameters<typeof makeConfig>[0] = {}): AbxConfig {
  return makeConfig({
    upstreams: [anthropic],
    egress: [makeEgressRule({ pattern: 'api.anthropic.com', upstreamId: 'anthropic' })],
    ...overrides,
  })
}

function resolve(config: AbxConfig, route: Parameters<typeof resolveTarget>[0]['route'], search = '') {
  const index = buildUpstreamIndex(config.upstreams)
  return resolveTarget({
    config,
    route,
    search,
    secrets: { env: ENV, readFile },
    upstreamsById: index.byId,
    upstreamIndex: index,
  })
}

describe('concatUpstreamPath', () => {
  it('baseUrl 没有路径前缀时就是简单拼接', () => {
    const joined = concatUpstreamPath('https://api.anthropic.com', '/v1/messages', '')
    expect(joined?.origin.origin).toBe('https://api.anthropic.com')
    expect(joined?.path).toBe('/v1/messages')
  })

  it('baseUrl 自带路径前缀时保留前缀', () => {
    // `new URL('/v1/messages', 'https://gw.example.com/anthropic')` 会把
    // `/anthropic` 丢掉，所以这里是拼字符串而不是用 URL 解析。
    const joined = concatUpstreamPath('https://gw.example.com/anthropic', '/v1/messages', '')
    expect(joined?.path).toBe('/anthropic/v1/messages')
  })

  it('baseUrl 末尾的斜杠不会拼出双斜杠', () => {
    expect(concatUpstreamPath('https://api.anthropic.com/', '/v1/messages', '')?.path).toBe('/v1/messages')
    expect(concatUpstreamPath('https://gw.example.com/anthropic//', '/v1', '')?.path).toBe('/anthropic/v1')
  })

  it('查询串带在最后', () => {
    expect(concatUpstreamPath('https://api.anthropic.com', '/v1/messages', '?beta=true')?.path).toBe(
      '/v1/messages?beta=true',
    )
  })

  it('非法 baseUrl 返回 null', () => {
    expect(concatUpstreamPath('not a url', '/v1', '')).toBeNull()
  })
})

describe('resolveTarget', () => {
  describe('上游路由', () => {
    it('注入真实密钥', () => {
      const result = resolve(baseConfig(), { kind: 'upstream', upstreamId: 'anthropic', path: '/v1/messages' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.auth).toEqual({ header: 'authorization', value: `Bearer ${FAKE_SECRET}` })
      expect(result.upstreamId).toBe('anthropic')
      expect(result.targetHost).toBe('api.anthropic.com')
      expect(result.path).toBe('/v1/messages')
    })

    it('认证头名统一小写', () => {
      const config = baseConfig({
        upstreams: [
          makeUpstream({
            id: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            authHeader: 'X-Api-Key',
            secretEnv: 'ANTHROPIC_API_KEY',
          }),
        ],
      })
      const result = resolve(config, { kind: 'upstream', upstreamId: 'anthropic', path: '/' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.auth?.header).toBe('x-api-key')
    })

    it('不存在的上游 id 是 404', () => {
      const result = resolve(baseConfig(), { kind: 'upstream', upstreamId: 'nope', path: '/' })
      expect(result).toMatchObject({ ok: false, status: 404, decision: 'denied-unknown-upstream' })
    })

    it('白名单对上游路由同样生效', () => {
      // 少了这一步，白名单就是摆设：给域名配个上游就能绕过。
      const config = baseConfig({ egress: [] })
      const result = resolve(config, { kind: 'upstream', upstreamId: 'anthropic', path: '/v1/messages' })
      expect(result).toMatchObject({ ok: false, status: 403, decision: 'denied-egress' })
    })

    it('拿不到密钥时不转发，返回 502', () => {
      const config = baseConfig({
        upstreams: [makeUpstream({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', secretEnv: 'NOT_SET' })],
      })
      const result = resolve(config, { kind: 'upstream', upstreamId: 'anthropic', path: '/' })
      expect(result).toMatchObject({ ok: false, status: 502, decision: 'credential-missing' })
    })

    it('拒绝时不会把密钥内容写进 detail', () => {
      const config = baseConfig({
        upstreams: [makeUpstream({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', secretEnv: 'NOT_SET' })],
      })
      const result = resolve(config, { kind: 'upstream', upstreamId: 'anthropic', path: '/' })
      if (result.ok) throw new Error('这个用例要求拒绝')
      expect(JSON.stringify(result)).not.toContain(FAKE_SECRET)
    })
  })

  describe('直通路由', () => {
    it('命中白名单且域名正好是某个上游时，注入那个上游的凭据', () => {
      const result = resolve(baseConfig(), {
        kind: 'passthrough',
        target: new URL('https://api.anthropic.com'),
        path: '/v1/messages',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.auth?.value).toBe(`Bearer ${FAKE_SECRET}`)
      expect(result.upstreamId).toBe('anthropic')
    })

    it('路径原样带过去，不拼 baseUrl 的路径', () => {
      const result = resolve(baseConfig(), {
        kind: 'passthrough',
        target: new URL('https://api.anthropic.com'),
        path: '/anything/at/all?x=1',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.path).toBe('/anything/at/all?x=1')
    })

    it('白名单规则绑定的上游优先于「域名恰好相同」的推断', () => {
      const config = baseConfig({
        upstreams: [
          anthropic,
          makeUpstream({ id: 'anthropic-mirror', baseUrl: 'https://api.anthropic.com', secretEnv: 'ANTHROPIC_API_KEY' }),
        ],
        egress: [makeEgressRule({ pattern: 'api.anthropic.com', upstreamId: 'anthropic-mirror' })],
      })
      const result = resolve(config, {
        kind: 'passthrough',
        target: new URL('https://api.anthropic.com'),
        path: '/v1',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.upstreamId).toBe('anthropic-mirror')
    })

    it('放行但没有对应上游时不注入凭据', () => {
      const config = baseConfig({ egress: [makeEgressRule({ pattern: 'cdn.example.com' })] })
      const result = resolve(config, {
        kind: 'passthrough',
        target: new URL('https://cdn.example.com'),
        path: '/img.png',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.auth).toBeNull()
      expect(result.upstreamId).toBeNull()
    })

    it('不在白名单是 403', () => {
      const result = resolve(baseConfig(), {
        kind: 'passthrough',
        target: new URL('https://evil.example.net'),
        path: '/',
      })
      expect(result).toMatchObject({ ok: false, status: 403, decision: 'denied-egress' })
    })

    it('不在白名单时不会去读凭据', () => {
      // 决策链的顺序本身是安全属性：白名单在凭据之前。
      // 这里让 readFile 直接抛错，只要它被调用就会失败。
      const config = baseConfig({
        upstreams: [
          makeUpstream({ id: 'evil', baseUrl: 'https://evil.example.net', secretEnv: null, secretFile: '/run/secrets/x' }),
        ],
        egress: [],
      })
      const result = resolve(config, { kind: 'passthrough', target: new URL('https://evil.example.net'), path: '/' })
      expect(result).toMatchObject({ ok: false, decision: 'denied-egress' })
    })

    it('通配白名单按子域匹配', () => {
      const config = baseConfig({
        upstreams: [],
        egress: [makeEgressRule({ pattern: '*.example.com' })],
      })
      expect(
        resolve(config, { kind: 'passthrough', target: new URL('https://a.example.com'), path: '/' }).ok,
      ).toBe(true)
      expect(
        resolve(config, { kind: 'passthrough', target: new URL('https://example.com'), path: '/' }).ok,
      ).toBe(false)
    })
  })
})
