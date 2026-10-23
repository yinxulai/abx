/**
 * 端到端：真的起 broker、真的打 HTTP、真的把文件递出去。
 *
 * 这一组用例要证明的是**接线接对了**，而不是传递窗的逻辑对不对（那个在
 * `transom/*.test.ts` 里，用的是替身）。所以这里专挑那些只在「真 HTTP」下才出现的
 * 问题：舱令牌怎么变成身份、通知回什么、宿主面能不能打进来、请求体多大算太大。
 *
 * 其中有两条是这个功能的**红线在接线层的版本**：
 *
 *   - 宿主面打 `/mcp` 一律 403——那个面不校验身份，而传递窗做的每一件事都要落到
 *     某个舱头上；
 *   - 令牌有效但没登记会话时 409，**不猜**交付格与可写根。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig, makeEgressRule, makeUpstream } from '@abx/contracts/test-support'
import type { AbxConfig } from '@abx/contracts'
import { createMemoryTransomLedger, type MemoryTransomLedger } from '../transom/ledger'
import { createTransomMcpHandler } from '../transom/mcp'
import type { Opener } from '../transom/opener'
import { outboxDirFor } from '../transom/outbox'
import { createTransomService, type TransomSession } from '../transom/service'
import { createMemoryAuditSink, type MemoryAuditSink } from './audit'
import { MCP_MAX_REQUEST_BYTES, startBroker, type BrokerHandle } from './server'

/** 宿主固定令牌的形状是 `abx_cell_<hex>`。手写一个同形状的，因为它要塞进环境变量。 */
const CELL_TOKEN = 'abx_cell_test-token-transom-0123456789'
const AGENT_ID = 'claude'
const CELL_ID = 'claude-20261023-mcp001'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** 记账用的打开器替身：跑测试时不能真的弹窗。 */
interface StubOpener extends Opener {
  readonly calls: string[]
}

function stubOpener(): StubOpener {
  const calls: string[] = []
  return {
    name: 'stub-opener',
    calls,
    openFile: (absolutePath: string) => {
      calls.push(`open:${absolutePath}`)
      return Promise.resolve()
    },
    revealInFolder: (absolutePath: string) => {
      calls.push(`reveal:${absolutePath}`)
      return Promise.resolve()
    },
  }
}

interface TestBroker {
  readonly handle: BrokerHandle
  readonly audit: MemoryAuditSink
  readonly taskDir: string
  readonly outboxRoot: string
  readonly ledger: MemoryTransomLedger
  readonly opener: StubOpener
  /** 这次会话的舱令牌。默认是 `registerCell` 发的那一个。 */
  readonly token: string
  readonly cellId: string
}

interface StartOptions {
  /** 不接传递窗（验 503）。 */
  readonly withoutTransom?: boolean
  /** 接了传递窗，但不登记会话（验 409）。 */
  readonly withoutSession?: boolean
}

async function startTestBroker(options: StartOptions = {}): Promise<TestBroker> {
  const base = mkdtempSync(path.join(tmpdir(), 'abx-broker-mcp-'))
  const taskDir = path.join(base, 'task')
  const outboxRoot = path.join(base, 'outbox')
  mkdirSync(taskDir, { recursive: true })

  const audit = createMemoryAuditSink()
  const ledger = createMemoryTransomLedger()
  const opener = stubOpener()
  const config: AbxConfig = makeConfig({
    upstreams: [makeUpstream({ id: 'anthropic', baseUrl: 'http://127.0.0.1:1', secretEnv: 'ABX_TEST_UPSTREAM_KEY' })],
    egress: [makeEgressRule({ pattern: '127.0.0.1', upstreamId: 'anthropic' })],
  })

  const service = createTransomService({ outboxRoot, ledger, opener })
  const handle = await startBroker({
    config,
    env: { ABX_CELL_TOKEN: CELL_TOKEN, ABX_TEST_UPSTREAM_KEY: 'sk-ant-FAKE' },
    auditSink: audit,
    cellHost: '127.0.0.1',
    allowedCellSubnets: ['127.0.0.1/32'],
    hostPort: 0,
    cellPort: 0,
    transom: options.withoutTransom === true ? null : createTransomMcpHandler({ service }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })

  const session: TransomSession = {
    cellId: CELL_ID,
    agentId: AGENT_ID,
    roots: [{ cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' }],
  }
  // 令牌与身份是绑在一起的：登记出来的那一个才对应上面这个会话。环境变量里那个固定
  // 令牌只对应默认舱（`default`），而默认舱**没有**交付信息——这正是 409 那一条。
  const token = options.withoutSession === true ? CELL_TOKEN : handle.registerCell(CELL_ID, session)

  cleanups.push(() => handle.close())
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))

  return { handle, audit, taskDir, outboxRoot, ledger, opener, token, cellId: CELL_ID }
}

interface CallOptions {
  /** `null` = 一个令牌都不带。不传 = 用这次会话的令牌。 */
  readonly token?: string | null
  readonly face?: 'host' | 'cell'
  /** 直接给请求体原文，绕过 `JSON.stringify`。 */
  readonly raw?: string
  /** 默认 `/mcp`。 */
  readonly path?: string
}

interface McpReply {
  readonly status: number
  readonly body: string
  readonly json: Record<string, unknown>
}

/** 打一次 `/mcp`，把响应原样收下来（状态码、原文、解析结果）。 */
async function callMcp(broker: TestBroker, payload: unknown, options: CallOptions = {}): Promise<McpReply> {
  const origin = options.face === 'host' ? broker.handle.hostOrigin : broker.handle.cellOrigin
  const token = options.token === undefined ? broker.token : options.token
  const body = options.raw ?? JSON.stringify(payload)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['x-abx-cell'] = token

  const response = await fetch(`${origin}${options.path ?? '/mcp'}`, { method: 'POST', headers, body })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // 有些回复本来就没有体（202），解析不了是正常的。
    json = {}
  }
  return { status: response.status, body: text, json }
}

/** 在舱内的工作目录里放一个文件，返回它的**舱内**路径。 */
function cellFile(broker: TestBroker, name: string, content: string): string {
  writeFileSync(path.join(broker.taskDir, name), content)
  return `/workspace/${name}`
}

function toolCall(name: string, args: Record<string, unknown>, id: string | number = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

interface ToolResult {
  readonly isError: boolean
  readonly content: { type: string; text: string }[]
}

function resultOf(reply: McpReply): ToolResult {
  return reply.json.result as ToolResult
}

describe('传递窗挂在舱面上', () => {
  it('走完一次真实往返：initialize → tools/list → publish → open', async () => {
    const broker = await startTestBroker()

    const init = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(init.status).toBe(200)
    expect(init.json.result).toMatchObject({ serverInfo: { name: 'abx' }, capabilities: { tools: { listChanged: false } } })

    const list = await callMcp(broker, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((list.json.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['publish', 'open'])

    const cellPath = cellFile(broker, 'chart.png', 'not-really-a-png')
    const published = await callMcp(broker, toolCall('publish', { path: cellPath }, 3))
    const deliveredPath = path.join(outboxDirFor(broker.outboxRoot, broker.cellId), 'chart.png')
    expect(resultOf(published).isError).toBe(false)
    // 真的落到交付格里了，一个字节不差。
    expect(readFileSync(deliveredPath, 'utf8')).toBe('not-really-a-png')
    // 白名单里的类型：宿主侧真的被要求打开。
    expect(broker.opener.calls).toEqual([`open:${deliveredPath}`])

    const opened = await callMcp(broker, toolCall('open', { name: 'chart.png' }, 4))
    expect(resultOf(opened).isError).toBe(false)
    expect(broker.opener.calls).toHaveLength(2)
    // 两个动作各记一条账，身份都是从令牌来的。
    expect(broker.ledger.records.map((line) => `${line.cellId}/${line.agentId}/${line.action}`)).toEqual([
      `${CELL_ID}/${AGENT_ID}/publish`,
      `${CELL_ID}/${AGENT_ID}/open`,
    ])
  })

  it('令牌写在路径里也照样走通（/c/<token>/mcp）', async () => {
    const broker = await startTestBroker()

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null, path: `/c/${broker.token}/mcp` })

    expect(reply.status).toBe(200)
    // 审计里记的是**剥掉令牌之后**的路径：审计文件是最容易被收走的东西。
    expect(broker.audit.records.at(-1)?.path).toBe('/mcp')
  })

  it('通知（没有 id）回 202、没有回复体，但审计照样留一条', async () => {
    const broker = await startTestBroker()

    const reply = await callMcp(broker, { jsonrpc: '2.0', method: 'notifications/initialized' })

    expect(reply.status).toBe(202)
    expect(reply.body).toBe('')
    expect(broker.audit.records.at(-1)).toMatchObject({ decision: 'allowed', path: '/mcp', face: 'cell' })
  })

  it('字符串 id 原样回；工具被拒时是 200 + isError，不是 HTTP 错误', async () => {
    const broker = await startTestBroker()

    const reply = await callMcp(broker, toolCall('publish', { path: '/etc/passwd' }, 'req-7'))

    expect(reply.status).toBe(200)
    expect(reply.json.id).toBe('req-7')
    const result = resultOf(reply)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('不在这次会话的舱内目录里')
  })
})

describe('身份从令牌来，不从请求体来', () => {
  it('请求体里塞一个别人的会话与根，一点用都没有', async () => {
    // 「身份不可伪造」在 HTTP 层的版本：`cellId` 是从令牌反查出来的，可写根只可能
    // 来自注册表里登记的那一份——`params` 是舱内那个 agent 自己写的。
    const broker = await startTestBroker()
    const cellPath = cellFile(broker, 'chart.png', 'x')

    const reply = await callMcp(broker, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'publish',
        arguments: { path: cellPath },
        // 伪造：说自己叫别人，还说宿主的整个根目录都是自己的工作目录。
        session: { cellId: 'someone-else', agentId: 'codex', roots: [{ cellPath: '/', hostPath: '/', kind: 'workdir' }] },
      },
    })

    expect(resultOf(reply).isError).toBe(false)
    expect(broker.ledger.records[0]).toMatchObject({ cellId: CELL_ID, agentId: AGENT_ID })
  })

  it('没有令牌 / 令牌不对：401，一个字节都不进传递窗', async () => {
    const broker = await startTestBroker()

    const anonymous = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })
    expect(anonymous.status).toBe(401)
    expect(anonymous.json.error).toBe('abx_cell_token_required')

    const wrong = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'abx_cell_wrong' })
    expect(wrong.status).toBe(401)
    expect(broker.ledger.records).toHaveLength(0)
    expect(broker.audit.records.filter((record) => record.decision === 'denied-cell-token')).toHaveLength(2)
  })

  it('宿主面打 /mcp 一律 403：那个面没有身份', async () => {
    const broker = await startTestBroker()

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { face: 'host', token: null })

    expect(reply.status).toBe(403)
    expect(reply.json.error).toBe('abx_transom_cell_face_only')
    expect(broker.audit.records.at(-1)).toMatchObject({ face: 'host', decision: 'denied-route', status: 403 })
  })

  it('令牌有效但没登记会话：409，不猜交付格与可写根', async () => {
    // 接上一个已经在跑的 broker 就是这种情形：令牌是真的，但那个进程里的注册表
    // 不认这次会话。猜一个默认根，猜的就是「舱内哪个文件能递出去」这个判据本身。
    const broker = await startTestBroker({ withoutSession: true })

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(reply.status).toBe(409)
    expect(reply.json.error).toBe('abx_transom_session_unknown')
    expect(String(reply.json.detail)).toContain('不是本次会话起的')
  })

  it('broker 没接传递窗：503，说的是「没接」而不是「坏了」', async () => {
    const broker = await startTestBroker({ withoutTransom: true })

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(reply.status).toBe(503)
    expect(reply.json.error).toBe('abx_transom_unavailable')
  })
})

describe('协议层的坏输入', () => {
  it('不是 JSON：回 -32700（HTTP 200），而不是 HTTP 400', async () => {
    // 回 400 的话，客户端的 MCP 实现会把它当成传输层失败，「这条消息读不懂」就丢了。
    const broker = await startTestBroker()

    const reply = await callMcp(broker, null, { raw: '这不是 JSON' })

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
  })

  it('请求体太大：413，并说清上限是多少', async () => {
    const broker = await startTestBroker()
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(MCP_MAX_REQUEST_BYTES + 1024) })

    const reply = await callMcp(broker, null, { raw: huge })

    expect(reply.status).toBe(413)
    expect(reply.json.error).toBe('abx_transom_body_too_large')
    expect(String(reply.json.detail)).toContain('64.0 KiB')
  })

  it('/mcp 底下的别的路径照旧走老路：没有目标头就是 400', async () => {
    const broker = await startTestBroker()

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { path: '/mcp/extra' })

    expect(reply.status).toBe(400)
    expect(reply.json.error).toBe('abx_invalid_route')
  })

  it('带 X-Abx-Target 的 /mcp 走直通，不被传递窗接走', async () => {
    // 显式说了要去哪儿就以那个为准——`/mcp` 也可能正好是某个上游自己的端点。
    const broker = await startTestBroker()
    const response = await fetch(`${broker.handle.cellOrigin}/mcp`, {
      method: 'POST',
      headers: { 'x-abx-cell': broker.token, 'x-abx-target': 'https://not-in-whitelist.example' },
      body: '{}',
    })

    // 走到了白名单那一步（不在名单 → 403），而不是被传递窗处理掉。
    expect(response.status).toBe(403)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('abx_egress_denied')
  })
})

describe('关掉之后没有旁路', () => {
  it('broker 关掉之后 /mcp 连不上', async () => {
    const broker = await startTestBroker()
    const { cellOrigin } = broker.handle
    const token = broker.token
    await broker.handle.close()

    await expect(fetch(`${cellOrigin}/mcp`, { method: 'POST', headers: { 'x-abx-cell': token }, body: '{}' })).rejects.toThrow()
  })

  it('注销舱之后，原令牌立刻打不开传递窗', async () => {
    const broker = await startTestBroker()
    expect(broker.handle.unregisterCell(broker.cellId)).toBe(true)

    const reply = await callMcp(broker, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(reply.status).toBe(401)
    expect(reply.json.error).toBe('abx_cell_token_required')
  })
})
