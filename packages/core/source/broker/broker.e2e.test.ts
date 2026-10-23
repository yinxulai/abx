/**
 * 端到端：真的起一个上游 HTTP 服务，真的起 broker，真的打请求。
 *
 * 这一组用例是「本阶段到底做出来没有」的判据。它要证明的六件事：
 *
 *   1. 舱内发的占位符，到上游时已经变成真实密钥；
 *   2. 不在白名单的域名拿不到 403；
 *   3. 舱面没有令牌就是 401，宿主面不需要令牌；
 *   4. 每一次请求（放行和拒绝）都留下一行审计；
 *   5. 审计文件里**没有**密钥；
 *   6. broker 关掉之后请求就失败——没有旁路。
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig, makeEgressRule, makeUpstream } from '@abx/contracts/test-support'
import type { AbxConfig } from '@abx/contracts'
import { createMemoryAuditSink, type MemoryAuditSink } from './audit'
import { DEFAULT_CELL_ID, startBroker, type BrokerHandle } from './server'

/** 假的真实密钥。它出现在这个文件里是安全的：它不是一个能用的凭据。 */
const FAKE_SECRET = 'sk-ant-FAKE-3333333333333333333333333333'
const PLACEHOLDER = 'abx-placeholder-anthropic'
// 宿主固定令牌：真实的那份由 generateCellToken() 生成，形状是 `abx_cell_<hex>`。
// 这里手写一个同形状的值，因为它要塞进环境变量，得是已知的。
const CELL_TOKEN = 'abx_cell_test-token-0123456789'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

interface EchoUpstream {
  readonly origin: string
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

/** 假的「上游」。它把收到的每一个字节都记下来，供断言检查。 */
async function startEchoUpstream(): Promise<EchoUpstream> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const payload = JSON.stringify({ ok: true, url: request.url, seen: requests.length })
      response.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' })
      response.end(payload)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

interface TestBroker {
  readonly handle: BrokerHandle
  readonly audit: MemoryAuditSink
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface StartTestBrokerOptions {
  readonly upstreamOrigin: string
  readonly config?: AbxConfig
  readonly cellRegistryLimit?: number
  /**
   * 舱面允许的来源网段。
   *
   *   - 不给：`['127.0.0.1/32']`——这里的舱面绑在回环上，来源就是回环；
   *   - 给 `null`：**不传这个选项**，让 `startBroker` 用它自己的默认值（docker 网段）；
   *   - 给数组：照传。
   */
  readonly allowedCellSubnets?: readonly string[] | null
}

/** 需求里给 docker 的那两条网段。用来验「网段外拒绝」。 */
const DOCKER_SUBNETS = ['192.168.65.0/24', '172.17.0.0/16']

async function startTestBroker(options: StartTestBrokerOptions): Promise<TestBroker> {
  const audit = createMemoryAuditSink()
  // 舱面绑在回环上，这些用例的来源就都是回环，所以默认要把回环写进允许列表——
  // `startBroker` 的默认那份只认 docker 网段，而「网段外拒绝」的用例正是靠它生效的。
  const allowedCellSubnets = options.allowedCellSubnets === undefined ? ['127.0.0.1/32'] : options.allowedCellSubnets
  const config =
    options.config ??
    makeConfig({
      upstreams: [
        makeUpstream({
          id: 'anthropic',
          baseUrl: options.upstreamOrigin,
          secretEnv: 'ABX_TEST_UPSTREAM_KEY',
          authScheme: 'Bearer',
        }),
      ],
      egress: [
        makeEgressRule({ pattern: '127.0.0.1', upstreamId: 'anthropic' }),
        makeEgressRule({ pattern: '*.example.com' }),
      ],
    })

  const handle = await startBroker({
    config,
    env: { ABX_TEST_UPSTREAM_KEY: FAKE_SECRET, ABX_CELL_TOKEN: CELL_TOKEN },
    auditSink: audit,
    // 绑回环 + 端口 0：不碰 docker 网桥，也不占用固定端口。
    cellHost: '127.0.0.1',
    // null = 不传，用 startBroker 的默认值。
    ...(allowedCellSubnets === null ? {} : { allowedCellSubnets }),
    hostPort: 0,
    cellPort: 0,
    cellRegistryLimit: options.cellRegistryLimit ?? null,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })

  cleanups.push(() => handle.close())
  return { handle, audit }
}

function cellUrl(broker: TestBroker, path: string): string {
  return `${broker.handle.cellOrigin}${path}`
}

describe('broker 端到端', () => {
  it('凭据注入：舱内发占位符，上游收到真实密钥', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })
    const cellToken = broker.handle.registerCell('cell-e2e-1')

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages?beta=true'), {
      method: 'POST',
      headers: {
        'x-abx-cell': cellToken,
        authorization: `Bearer ${PLACEHOLDER}`,
        'content-type': 'application/json',
        'x-abx-cell-id': 'cell-e2e-1',
      },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)

    // 上游侧：拿到的是真实密钥，不是占位符。
    expect(upstream.requests).toHaveLength(1)
    const seen = upstream.requests[0]
    expect(seen?.headers['authorization']).toBe(`Bearer ${FAKE_SECRET}`)
    expect(seen?.headers['authorization']).not.toContain('placeholder')
    expect(seen?.headers['authorization']).not.toBe(`Bearer ${PLACEHOLDER}`)
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('/v1/messages?beta=true')
    expect(seen?.body).toBe(JSON.stringify({ hello: 'world' }))
    // 控制面头不会流到上游。
    expect(seen?.headers['x-abx-cell']).toBeUndefined()
    expect(seen?.headers['x-abx-cell-id']).toBeUndefined()

    // 审计：放行，且标记了注入。
    expect(broker.audit.records).toHaveLength(1)
    expect(broker.audit.records[0]).toMatchObject({
      cellId: 'cell-e2e-1',
      method: 'POST',
      path: '/u/anthropic/v1/messages?beta=true',
      upstreamId: 'anthropic',
      decision: 'allowed',
      status: 200,
      credentialInjected: true,
      face: 'cell',
    })
  })

  it('占位符是假的时候也照样被覆盖（broker 不校验它）', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN, authorization: 'Bearer garbage-from-the-cell' },
    })

    expect(upstream.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_SECRET}`)
  })

  it('舱内完全不发认证头时，broker 也会补上真实密钥', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), { headers: { 'x-abx-cell': CELL_TOKEN } })

    expect(upstream.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_SECRET}`)
  })

  it('不在白名单的域名返回 403，且上游一个字节都没收到', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/anything'), {
      headers: { 'x-abx-cell': CELL_TOKEN, 'x-abx-target': 'https://evil.example.net' },
    })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('abx_egress_denied')

    expect(upstream.requests).toHaveLength(0)
    expect(broker.audit.records).toHaveLength(1)
    expect(broker.audit.records[0]).toMatchObject({
      decision: 'denied-egress',
      status: 403,
      targetHost: 'evil.example.net',
      credentialInjected: false,
    })
  })

  it('直通模式：白名单命中但不改路径', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/some/deep/path?keep=me'), {
      headers: { 'x-abx-cell': CELL_TOKEN, 'x-abx-target': upstream.origin },
    })

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.url).toBe('/some/deep/path?keep=me')
    // 目标域名正好是配置过的上游，于是顺手把凭据也换掉了。
    expect(upstream.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_SECRET}`)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'allowed', upstreamId: 'anthropic' })
  })

  it('舱面没有令牌就是 401，并留一条审计', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'))

    expect(response.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'denied-cell-token', status: 401 })
  })

  it('舱面令牌不对也是 401', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': 'wrong-token' },
    })

    expect(response.status).toBe(401)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'denied-cell-token' })
  })

  it('A 舱的令牌不能访问 B 舱：伪造 cell id 头就是 401', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })
    const tokenA = broker.handle.registerCell('cell-a')
    broker.handle.registerCell('cell-b')

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': tokenA, 'x-abx-cell-id': 'cell-b' },
    })

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('abx_cell_id_mismatch')
    expect(upstream.requests).toHaveLength(0)
    // 审计记的是令牌真正的归属，不是伪造的头。
    expect(broker.audit.records[0]).toMatchObject({
      cellId: 'cell-a',
      decision: 'denied-cell-identity',
      status: 401,
      face: 'cell',
    })
  })

  it('没有 cell id 头时，审计仍用令牌反查出来的身份', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })
    const tokenA = broker.handle.registerCell('cell-a')
    broker.handle.registerCell('cell-b')

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': tokenA },
    })

    expect(response.status).toBe(200)
    expect(broker.audit.records[0]).toMatchObject({ cellId: 'cell-a', decision: 'allowed' })
  })

  it('unregister 之后原令牌立刻失效', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })
    const cellToken = broker.handle.registerCell('cell-a')

    const before = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': cellToken },
    })
    expect(before.status).toBe(200)

    expect(broker.handle.unregisterCell('cell-a')).toBe(true)

    const after = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': cellToken },
    })
    expect(after.status).toBe(401)
    expect(broker.audit.records[1]).toMatchObject({ decision: 'denied-cell-token', status: 401 })
  })

  it('按舱注册的令牌带可扫描前缀，走完整条链路还是 200', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })
    const token = broker.handle.registerCell('cell-prefixed')

    // 前缀是为了「泄漏之后能 grep 到」，不是为了识别。格式断言只钉住这一点：
    // 前缀 + 32 字节 hex。
    expect(token).toMatch(/^abx_cell_[0-9a-f]{64}$/)

    // 带前缀的令牌要照常走完提取、反查、路由、转发：格式变了不代表行为变了。
    const response = await fetch(cellUrl(broker, `/c/${token}/u/anthropic/v1/messages`), {
      headers: { 'x-abx-cell': token },
    })

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.url).toBe('/v1/messages')
    expect(broker.audit.records[0]).toMatchObject({ cellId: 'cell-prefixed', decision: 'allowed' })
    // 而审计里不许出现令牌本身，前缀也一样。
    for (const line of broker.audit.lines) expect(line).not.toContain(token)
    expect(broker.audit.lines.join('\n')).not.toContain('abx_cell_')
  })

  it('宿主固定令牌仍然能用，且只对应默认舱', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN, 'x-abx-cell-id': DEFAULT_CELL_ID },
    })

    expect(response.status).toBe(200)
    expect(broker.audit.records[0]).toMatchObject({ cellId: DEFAULT_CELL_ID, decision: 'allowed' })
  })

  it('注册超过上限时失败，错误里带当前数量与上限', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    // 默认舱占一个位置，所以上限 2 只还能再登记一个。
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin, cellRegistryLimit: 2 })

    broker.handle.registerCell('cell-a')
    expect(() => broker.handle.registerCell('cell-b')).toThrow(/当前 2 个舱/)
    expect(() => broker.handle.registerCell('cell-b')).toThrow(/上限 2 个舱/)
  })

  // 这一组是「来源网段」那道闸的判据。实测过的事实：宿主回环打舱面 → 200，
  // 也就是说这道闸当时根本不存在。
  describe('来源网段', () => {
    it('网段外的来源，令牌正确也是 403', async () => {
      const upstream = await startEchoUpstream()
      cleanups.push(() => upstream.close())
      // 只认 docker 网段，而这条连接来自 127.0.0.1。
      const broker = await startTestBroker({ upstreamOrigin: upstream.origin, allowedCellSubnets: DOCKER_SUBNETS })

      const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
        headers: { 'x-abx-cell': CELL_TOKEN },
      })

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'abx_cell_source_denied' })
      // 被挡在令牌之前，所以上游一个字节都没收到。
      expect(upstream.requests).toHaveLength(0)

      // 审计里要有这件事，并且要能看出是谁在打。
      expect(broker.audit.records).toHaveLength(1)
      expect(broker.audit.records[0]).toMatchObject({
        decision: 'denied-cell-source',
        status: 403,
        sourceAddress: '127.0.0.1',
        face: 'cell',
      })
    })

    it('来源在网段外时，令牌对不对都是同一个 403', async () => {
      const upstream = await startEchoUpstream()
      cleanups.push(() => upstream.close())
      const broker = await startTestBroker({ upstreamOrigin: upstream.origin, allowedCellSubnets: DOCKER_SUBNETS })
      const goodToken = broker.handle.registerCell('cell-source-order')

      const withGoodToken = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
        headers: { 'x-abx-cell': goodToken },
      })
      const withJunkToken = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
        headers: { 'x-abx-cell': 'not-even-close' },
      })

      // 顺序的可观察证据：一个 401 都不该出现。先比令牌的话，网段外的探测者
      // 就能拿 401 / 403 的差别一位一位地把令牌试出来。
      expect(withGoodToken.status).toBe(403)
      expect(withJunkToken.status).toBe(403)
      expect(broker.audit.records.map((record) => record.decision)).toEqual([
        'denied-cell-source',
        'denied-cell-source',
      ])
    })

    it('允许列表为空时全部拒绝', async () => {
      const upstream = await startEchoUpstream()
      cleanups.push(() => upstream.close())
      const broker = await startTestBroker({ upstreamOrigin: upstream.origin, allowedCellSubnets: [] })

      const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
        headers: { 'x-abx-cell': CELL_TOKEN },
      })

      expect(response.status).toBe(403)
      expect(broker.audit.records[0]).toMatchObject({ decision: 'denied-cell-source', sourceAddress: '127.0.0.1' })
    })

    it('不传允许列表时用默认值，回环来源因此能进来', async () => {
      const upstream = await startEchoUpstream()
      cleanups.push(() => upstream.close())
      const broker = await startTestBroker({ upstreamOrigin: upstream.origin, allowedCellSubnets: null })

      const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
        headers: { 'x-abx-cell': CELL_TOKEN },
      })

      // 默认列表里有回环，这是实测逼出来的（见 cell-source.ts）：Docker Desktop 上
      // 容器打宿主的连接就是落在宿主回环上的，少了它舱一个请求都进不来。
      // 「挡住网段外的来源」由上面那几条用例用显式的窄列表验。
      expect(response.status).toBe(200)
      expect(broker.audit.records[0]).toMatchObject({ decision: 'allowed', sourceAddress: '127.0.0.1' })
    })

    it('宿主面不受网段限制', async () => {
      const upstream = await startEchoUpstream()
      cleanups.push(() => upstream.close())
      // 宿主面绑在回环上、本来就没有鉴权，来源判定只加在舱面。
      const broker = await startTestBroker({ upstreamOrigin: upstream.origin, allowedCellSubnets: DOCKER_SUBNETS })

      const response = await fetch(`${broker.handle.hostOrigin}/u/anthropic/v1/messages`)

      expect(response.status).toBe(200)
      expect(broker.audit.records[0]).toMatchObject({ face: 'host', decision: 'allowed', sourceAddress: '127.0.0.1' })
    })
  })

  it('宿主面不校验令牌', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(`${broker.handle.hostOrigin}/u/anthropic/v1/messages`)

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_SECRET}`)
    expect(broker.audit.records[0]).toMatchObject({ face: 'host', decision: 'allowed' })
  })

  it('令牌写在路径里也能用，且审计里不会留下令牌', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, `/c/${CELL_TOKEN}/u/anthropic/v1/messages`))

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.url).toBe('/v1/messages')

    // 记的是剥掉令牌之后的路径。审计文件恰恰是最容易被收集走的东西。
    expect(broker.audit.records[0]?.path).toBe('/u/anthropic/v1/messages')
    for (const line of broker.audit.lines) expect(line).not.toContain(CELL_TOKEN)
  })

  it('上游没配凭据时返回 502，不发匿名请求出去', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({
      upstreamOrigin: upstream.origin,
      config: makeConfig({
        upstreams: [
          makeUpstream({ id: 'anthropic', baseUrl: upstream.origin, secretEnv: 'ABX_TEST_NOT_SET' }),
        ],
        egress: [makeEgressRule({ pattern: '127.0.0.1', upstreamId: 'anthropic' })],
      }),
    })

    const response = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN },
    })

    expect(response.status).toBe(502)
    expect(upstream.requests).toHaveLength(0)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'credential-missing', status: 502 })
  })

  it('不存在的上游返回 404', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/u/nope/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN },
    })

    expect(response.status).toBe(404)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'denied-unknown-upstream' })
  })

  it('既没有上游前缀也没有目标头是 400', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(cellUrl(broker, '/v1/messages'), { headers: { 'x-abx-cell': CELL_TOKEN } })

    expect(response.status).toBe(400)
    expect(broker.audit.records[0]).toMatchObject({ decision: 'denied-route', status: 400 })
  })

  it('健康检查可用，且不写审计', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const response = await fetch(`${broker.handle.hostOrigin}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, face: 'host', upstreams: 1 })
    expect(broker.audit.records).toHaveLength(0)
  })

  it('审计流水里没有任何密钥', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN, authorization: `Bearer ${PLACEHOLDER}` },
    })
    await fetch(cellUrl(broker, '/x'), {
      headers: { 'x-abx-cell': CELL_TOKEN, 'x-abx-target': 'https://evil.example.net' },
    })

    expect(broker.audit.records).toHaveLength(2)
    const text = broker.audit.lines.join('\n')
    expect(text).not.toContain(FAKE_SECRET)
    expect(text).not.toContain(PLACEHOLDER)
    expect(text).not.toContain('Bearer')
    expect(text).not.toContain(CELL_TOKEN)
    expect(text).not.toContain('authorization')
    // 但「注入成功了」这件事必须在。
    expect(broker.audit.records[0]?.credentialInjected).toBe(true)
  })

  it('中文和超长路径也能安全落审计', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    await fetch(cellUrl(broker, `/u/anthropic/${'a'.repeat(3000)}`), { headers: { 'x-abx-cell': CELL_TOKEN } })

    const line = broker.audit.lines[0] ?? ''
    expect(() => JSON.parse(line)).not.toThrow()
    expect(line).toContain('truncated')
  })

  it('broker 关掉之后请求就失败，没有旁路', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    const before = await fetch(cellUrl(broker, '/u/anthropic/v1/messages'), {
      headers: { 'x-abx-cell': CELL_TOKEN },
    })
    expect(before.status).toBe(200)

    const cellOrigin = broker.handle.cellOrigin
    const hostOrigin = broker.handle.hostOrigin
    await broker.handle.close()

    await expect(fetch(`${cellOrigin}/u/anthropic/v1/messages`, { headers: { 'x-abx-cell': CELL_TOKEN } })).rejects.toThrow()
    await expect(fetch(`${hostOrigin}/u/anthropic/v1/messages`)).rejects.toThrow()
  })

  it('两个面绑在不同的端口上', async () => {
    const upstream = await startEchoUpstream()
    cleanups.push(() => upstream.close())
    const broker = await startTestBroker({ upstreamOrigin: upstream.origin })

    expect(broker.handle.hostOrigin).not.toBe(broker.handle.cellOrigin)
    expect(broker.handle.hostOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(broker.handle.cellTokenSource).toBe('env')
  })
})
