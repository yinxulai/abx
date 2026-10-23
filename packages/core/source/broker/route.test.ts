import { describe, expect, it } from 'vitest'
import { extractCellToken, resolveRoute } from './route'

function route(pathname: string, search = '', headers: Record<string, string> = {}) {
  return resolveRoute({ pathname, search, headers })
}

describe('resolveRoute', () => {
  describe('上游路由', () => {
    it('/u/<id>/<path> 拆成 id 和路径', () => {
      expect(route('/u/anthropic/v1/messages')).toEqual({
        kind: 'upstream',
        upstreamId: 'anthropic',
        path: '/v1/messages',
      })
    })

    it('/u/<id> 后面什么都不带时路径是 /', () => {
      expect(route('/u/anthropic')).toEqual({ kind: 'upstream', upstreamId: 'anthropic', path: '/' })
      expect(route('/u/anthropic/')).toEqual({ kind: 'upstream', upstreamId: 'anthropic', path: '/' })
    })

    it('查询串不参与路由', () => {
      expect(route('/u/anthropic/v1/messages', '?beta=true')).toEqual({
        kind: 'upstream',
        upstreamId: 'anthropic',
        path: '/v1/messages',
      })
    })

    it('只有 /u 没有 id 是无效路由', () => {
      // 静默命中「第一个上游」是那种上线三个月后才被发现的 bug。
      const result = route('/u')
      expect(result.kind).toBe('invalid')
      expect(route('/u/').kind).toBe('invalid')
    })
  })

  describe('直通路由', () => {
    it('从 X-Abx-Target 头取目标', () => {
      const result = route('/v1/messages', '?a=1', { 'x-abx-target': 'https://api.openai.com' })
      expect(result.kind).toBe('passthrough')
      if (result.kind !== 'passthrough') return
      expect(result.target.origin).toBe('https://api.openai.com')
      expect(result.path).toBe('/v1/messages?a=1')
    })

    it('没写协议时补 https，不降级成明文', () => {
      const result = route('/v1', '', { 'x-abx-target': 'api.openai.com' })
      expect(result.kind).toBe('passthrough')
      if (result.kind !== 'passthrough') return
      expect(result.target.protocol).toBe('https:')
    })

    it('显式写了 http 就尊重它', () => {
      const result = route('/v1', '', { 'x-abx-target': 'http://127.0.0.1:9000' })
      expect(result.kind).toBe('passthrough')
      if (result.kind !== 'passthrough') return
      expect(result.target.origin).toBe('http://127.0.0.1:9000')
    })

    it('没有目标头就是无效路由', () => {
      const result = route('/v1/messages')
      expect(result.kind).toBe('invalid')
    })

    it('非法地址是无效路由', () => {
      expect(route('/v1', '', { 'x-abx-target': 'ht!tp://%%%' }).kind).toBe('invalid')
    })

    it('非 http/https 协议被拒绝', () => {
      // 不拦的话 `file://` 这类协议会被塞进 http.request，行为取决于 Node 版本。
      const result = route('/v1', '', { 'x-abx-target': 'file:///etc/passwd' })
      expect(result.kind).toBe('invalid')
    })
  })

  it('健康检查单独成一路', () => {
    expect(route('/healthz')).toEqual({ kind: 'health' })
  })

  describe('传递窗', () => {
    it('/mcp 是传递窗，不是直通', () => {
      // 落进直通那条路的话，它会得到「不知道该转发到哪儿」——而它本来就不该被转发。
      expect(route('/mcp')).toEqual({ kind: 'mcp' })
    })

    it('显式给了目标头就走直通', () => {
      // `/mcp` 也可能正好是某个上游自己的端点。显式说了去哪儿就以那个为准。
      const result = route('/mcp', '', { 'x-abx-target': 'https://api.example.com' })
      expect(result.kind).toBe('passthrough')
    })

    it('目标头是空串时仍然算传递窗', () => {
      // 空串等于没写。判成直通的话，一个空头就能让一个正常请求变成 400。
      expect(route('/mcp', '', { 'x-abx-target': '' })).toEqual({ kind: 'mcp' })
    })

    it('只有 /mcp 这一条路径，别的不吃', () => {
      expect(route('/mcp/').kind).toBe('invalid')
      expect(route('/mcp/extra').kind).toBe('invalid')
      expect(route('/mcpx').kind).toBe('invalid')
    })

    it('查询串不影响判定', () => {
      expect(route('/mcp', '?a=1')).toEqual({ kind: 'mcp' })
    })
  })
})

describe('extractCellToken', () => {
  const inPath = { allowInPath: true }
  const headerOnly = { allowInPath: false }

  it('请求头里的令牌', () => {
    expect(extractCellToken({ pathname: '/u/x/y', headers: { 'x-abx-cell': 'tok' } }, inPath)).toEqual({
      token: 'tok',
      source: 'header',
      pathname: '/u/x/y',
    })
  })

  it('路径前缀里的令牌，前缀被剥掉', () => {
    expect(extractCellToken({ pathname: '/c/tok/u/x/y', headers: {} }, inPath)).toEqual({
      token: 'tok',
      source: 'path',
      pathname: '/u/x/y',
    })
  })

  it('关掉路径令牌之后，前缀原样留在路径里', () => {
    // 留着而不是剥掉：关掉这个开关的人，语义应该是「这个前缀不是令牌」，
    // 于是它变成一个普通的路径段，会被路由判成无效请求。
    expect(extractCellToken({ pathname: '/c/tok/u/x/y', headers: {} }, headerOnly)).toEqual({
      token: null,
      source: null,
      pathname: '/c/tok/u/x/y',
    })
  })

  it('两个都带时以请求头为准', () => {
    const result = extractCellToken(
      { pathname: '/c/old-token/u/x', headers: { 'x-abx-cell': 'new-token' } },
      inPath,
    )
    expect(result.token).toBe('new-token')
    expect(result.source).toBe('header')
  })

  it('令牌从头里来的时候，路径前缀照样要剥掉', () => {
    // 这条是端到端跑出来的回归：两个机制都开着时，真实的 claude 会话发出来的是
    // `/c/<token>/u/anthropic/v1/messages` 且同时带着 X-Abx-Cell 头。
    // 曾经这里只换令牌、不剥前缀，于是路径以 /c/ 开头，路由判定说
    // 「没有 /u/<upstreamId>/ 前缀」——两个机制都开着反而全盘不可用。
    const result = extractCellToken(
      { pathname: '/c/the-token/u/anthropic/v1/messages', headers: { 'x-abx-cell': 'the-token' } },
      inPath,
    )
    expect(result.token).toBe('the-token')
    expect(result.source).toBe('header')
    expect(result.pathname).toBe('/u/anthropic/v1/messages')
  })

  it('剥前缀跟放行是两件事：配置关掉路径前缀也照样剥', () => {
    // 剥前缀不构成任何放行——放行与否仍然由令牌比对决定。留着不剥只会让
    // 报错变成「不知道要转发到哪儿」，让人往配置上找问题。
    const result = extractCellToken(
      { pathname: '/c/the-token/u/anthropic/v1/messages', headers: { 'x-abx-cell': 'the-token' } },
      headerOnly,
    )
    expect(result.pathname).toBe('/u/anthropic/v1/messages')
  })

  it('只有前缀、后面没有路径时剥成根路径', () => {
    const result = extractCellToken({ pathname: '/c/tok', headers: { 'x-abx-cell': 'tok' } }, inPath)
    expect(result.pathname).toBe('/')
  })

  it('前缀剥完之后仍然是一条能用的上游路由', () => {
    const extracted = extractCellToken(
      { pathname: '/c/tok/u/anthropic/v1/messages', headers: { 'x-abx-cell': 'tok' } },
      inPath,
    )
    expect(route(extracted.pathname)).toEqual({
      kind: 'upstream',
      upstreamId: 'anthropic',
      path: '/v1/messages',
    })
  })

  it('没带令牌', () => {
    expect(extractCellToken({ pathname: '/u/x', headers: {} }, inPath)).toEqual({
      token: null,
      source: null,
      pathname: '/u/x',
    })
  })

  it('空的令牌头当成没带', () => {
    expect(extractCellToken({ pathname: '/u/x', headers: { 'x-abx-cell': '' } }, inPath).token).toBeNull()
  })

  it('路径前缀后面的根路径', () => {
    expect(extractCellToken({ pathname: '/c/tok', headers: {} }, inPath)).toEqual({
      token: 'tok',
      source: 'path',
      pathname: '/',
    })
  })

  it('空令牌的路径前缀不认', () => {
    expect(extractCellToken({ pathname: '/c//u/x', headers: {} }, inPath).token).toBeNull()
  })
})
