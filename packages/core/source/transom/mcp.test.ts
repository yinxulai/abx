/**
 * MCP 面的用例：**只喂消息、只看回复**。
 *
 * 这一层不碰 stdio、不碰 HTTP，所以它可以像别的纯函数一样测——而它恰好是协议层，
 * 协议层最该被这样测：一条一条消息进去，一条一条回复出来，逐字断言。
 *
 * 重点在两处：
 *
 *   - **工具面就是 `publish` / `open`。** 有一条用例把 `tools/list` 的原始回复钉死，
 *     于是「谁往里面加了一个 `run_shell`」这件事一定会弄红一条测试。
 *   - **会话从第二个参数进来，不从 `params` 进来。** 舱内那个 agent 能写 `params`，
 *     让它捎带身份就等于让它自报身份。下面有一条用例专门拿伪造的 `session` 试它。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRANSOM_SERVER_NAME, TRANSOM_SERVER_VERSION, TRANSOM_TOOL_NAMES } from '@abx/contracts'
import type { Opener } from './opener'
import { createMemoryTransomLedger, type MemoryTransomLedger } from './ledger'
import { createTransomMcpHandler, MCP_PROTOCOL_VERSION, type TransomMcpHandler } from './mcp'
import { createTransomService, type TransomSession } from './service'

const CELL_ID = 'claude-20261023-abc123'
const FIXED_TIME = new Date('2026-10-23T12:00:00.000Z')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

interface StubOpener extends Opener {
  readonly calls: string[]
}

/** 记账用的替身。**一个窗口都不弹**。 */
function stubOpener(): StubOpener {
  const calls: string[] = []
  return {
    name: 'stub-opener',
    calls,
    openFile(absolutePath: string): Promise<void> {
      calls.push(`open:${absolutePath}`)
      return Promise.resolve()
    },
    revealInFolder(absolutePath: string): Promise<void> {
      calls.push(`reveal:${absolutePath}`)
      return Promise.resolve()
    },
  }
}

interface Fixture {
  readonly taskDir: string
  readonly session: TransomSession
  readonly ledger: MemoryTransomLedger
  readonly opener: StubOpener
  readonly handler: TransomMcpHandler
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-mcp-'))
  directories.push(base)
  const taskDir = path.join(base, 'task')
  mkdirSync(taskDir)

  const session: TransomSession = {
    cellId: CELL_ID,
    agentId: 'claude',
    roots: [{ cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' }],
  }
  const ledger = createMemoryTransomLedger()
  const opener = stubOpener()
  const service = createTransomService({
    outboxRoot: path.join(base, 'outbox'),
    ledger,
    opener,
    now: () => FIXED_TIME,
  })
  return { taskDir, session, ledger, opener, handler: createTransomMcpHandler({ service }) }
}

/** 在舱内的工作目录里放一个文件，返回舱内路径。 */
function inCell(f: Fixture, name: string, content: string): string {
  writeFileSync(path.join(f.taskDir, name), content)
  return `/workspace/${name}`
}

/** 一次请求。id 固定，免得每条断言都要自己写一个。 */
async function request(f: Fixture, message: unknown, session: TransomSession = f.session): Promise<Record<string, unknown>> {
  const reply = await f.handler.handle(message, session)
  expect(reply, '这一条应该有回复').not.toBeNull()
  return reply as Record<string, unknown>
}

/** 一次工具调用的回复：错误与否，以及它要说给 agent 听的那段话。 */
interface ToolReply {
  readonly isError: boolean
  readonly text: string
}

/** 一次 `tools/call`，返回 `result`。 */
async function callTool(f: Fixture, name: string, args: unknown): Promise<ToolReply> {
  const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const result = reply.result as { content: { type: string; text: string }[]; isError?: boolean }
  return { isError: result.isError === true, text: result.content.map((part) => part.text).join('') }
}

/** `callTool` 的换会话版本：会话是第二个参数，与消息体无关。 */
async function callToolWith(f: Fixture, session: TransomSession, name: string, args: unknown): Promise<ToolReply> {
  const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, session)
  const result = reply.result as { content: { type: string; text: string }[]; isError?: boolean }
  return { isError: result.isError === true, text: result.content.map((part) => part.text).join('') }
}

describe('initialize：握手', () => {
  it('回协议版本、能力、自报的名字，以及那段 instructions', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } })

    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(1)
    const result = reply.result as Record<string, unknown>
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(result.capabilities).toEqual({ tools: { listChanged: false } })
    expect(result.serverInfo).toEqual({ name: TRANSOM_SERVER_NAME, version: TRANSOM_SERVER_VERSION })
    // instructions 是 agent 学会「做好的东西可以递出去」的唯一入口，不能是空的。
    expect(result.instructions).toContain('publish')
  })

  it('认识的版本就确认它——协商是双向的，不能只顾自己报一个', async () => {
    const f = fixture()
    for (const version of ['2025-03-26', '2024-11-05']) {
      const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } })
      expect((reply.result as { protocolVersion: string }).protocolVersion, version).toBe(version)
    }
  })

  it('不认识的版本：报我们自己的，而不是假装认识', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect((reply.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('没有 params 也能握手——不是每个客户端都会带', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((reply.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })
})

describe('tools/list：工具面', () => {
  it('就是 publish 与 open 两个，名字与顺序都和产品承诺一致', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (reply.result as { tools: { name: string }[] }).tools

    expect(tools.map((tool) => tool.name)).toEqual([...TRANSOM_TOOL_NAMES])
    expect(tools.map((tool) => tool.name)).toEqual(['publish', 'open'])
  })

  it('参数形状：publish 要 path，open 要 name，都必填、不给多余的键', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (reply.result as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools

    for (const tool of tools) {
      const schema = tool.inputSchema
      expect(schema.type, tool.name).toBe('object')
      expect(schema.additionalProperties, tool.name).toBe(false)
      expect((schema.required as string[]).length, tool.name).toBe(1)
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
    }
    expect(tools[0]?.inputSchema.required).toEqual(['path'])
    expect(tools[1]?.inputSchema.required).toEqual(['name'])
  })

  it('**红线**：这份列表里没有、也不会有 http_fetch / run_shell 这类东西', async () => {
    // 「永远不做」与「以后再做」的区别，在代码里就是这一条断言。
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const serialized = JSON.stringify(reply.result)
    for (const forbidden of ['http_fetch', 'fetch_url', 'run_shell', 'exec', 'shell', 'run_command', 'read_file', 'write_file']) {
      expect(serialized.includes(forbidden), `工具面里出现了 ${forbidden}`).toBe(false)
    }
  })
})

describe('tools/call：publish', () => {
  it('递出去、被打开，回复里带 sha256（用户要拿它跟舱内对）', async () => {
    const f = fixture()
    const content = 'PNG-but-actually-text'
    const digest = createHash('sha256').update(content).digest('hex')

    const result = await callTool(f, 'publish', { path: inCell(f, 'chart.png', content) })

    expect(result.isError).toBe(false)
    expect(result.text).toContain('chart.png')
    expect(result.text).toContain(digest)
    expect(f.opener.calls.some((call) => call.startsWith('open:'))).toBe(true)
    expect(f.ledger.records[0]).toMatchObject({ action: 'publish', outcome: 'opened', cellId: CELL_ID })
  })

  it('白名单之外：工具调用**成功**，但说明没有打开', async () => {
    // 交付成功、宿主没打开，这是最常见的一种结果。把它报成 isError=true 会让
    // agent 以为事情失败了，于是它可能反复重试。
    const f = fixture()
    const result = await callTool(f, 'publish', { path: inCell(f, 'setup.sh', 'echo hi') })

    expect(result.isError).toBe(false)
    expect(result.text).toContain('没有自动打开')
    expect(f.opener.calls.every((call) => call.startsWith('reveal:'))).toBe(true)
  })

  it('舱外的来源：isError=true，理由就是拒绝理由原文', async () => {
    const f = fixture()
    const result = await callTool(f, 'publish', { path: '/etc/passwd' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('不在这次会话的舱内目录里')
    expect(f.ledger.records[0]).toMatchObject({ outcome: 'rejected' })
  })

  it('path 不是字符串 / 根本没给：工具层面的错，不是协议错', async () => {
    const f = fixture()
    for (const args of [{}, { path: 42 }, { path: null }]) {
      const result = await callTool(f, 'publish', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.text).toContain('path')
    }
    // 参数不对时**不碰**账本：什么都没发生，就不该有账。
    expect(f.ledger.records).toHaveLength(0)
  })
})

describe('tools/call：open', () => {
  it('打开已经交付过的那一份', async () => {
    const f = fixture()
    await callTool(f, 'publish', { path: inCell(f, 'chart.png', 'x') })
    f.opener.calls.length = 0

    const result = await callTool(f, 'open', { name: 'chart.png' })

    expect(result.isError).toBe(false)
    expect(result.text).toContain('已打开')
    expect(f.ledger.records[1]).toMatchObject({ action: 'open', outcome: 'opened' })
  })

  it('先递 .sh 再 open：**同一个白名单管着两条路**', async () => {
    const f = fixture()
    await callTool(f, 'publish', { path: inCell(f, 'setup.sh', 'echo hi') })
    f.opener.calls.length = 0

    const result = await callTool(f, 'open', { name: 'setup.sh' })

    expect(result.text).toContain('没有打开')
    expect(f.opener.calls).toEqual([expect.stringMatching(/^reveal:/)])
  })

  it('不在交付格里：isError=true，并说清里面有什么', async () => {
    const f = fixture()
    const result = await callTool(f, 'open', { name: 'nope.png' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('还是空的')
  })

  it('name 不是字符串：工具层面的错，理由点名参数', async () => {
    const f = fixture()
    const result = await callTool(f, 'open', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('name')
  })
})

describe('会话不在消息里', () => {
  it('params 里塞一个假 session / cellId 没有任何用', async () => {
    // 这一条是这一层的安全要害：`params` 是舱内那个 agent 能随便写的。
    // 会话只从第二个参数进来，所以消息里那份假的连读都不会被读到。
    const f = fixture()
    await callTool(f, 'publish', { path: inCell(f, 'chart.png', 'x') })

    const forged = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'open',
        arguments: { name: 'chart.png' },
        session: { cellId: 'someone-else', agentId: 'codex', roots: [{ cellPath: '/', hostPath: '/', kind: 'workdir' }] },
        cellId: 'someone-else',
      },
    }
    const reply = await request(f, forged)
    expect((reply.result as { isError?: boolean }).isError).not.toBe(true)
    // 账上的身份是我们传进去的那个会话，不是消息里那个。
    expect(f.ledger.records[0]?.cellId).toBe(CELL_ID)
    expect(f.ledger.records[0]?.agentId).toBe('claude')
  })

  it('换个会话调 open：看不见别人的交付格', async () => {
    const f = fixture()
    await callTool(f, 'publish', { path: inCell(f, 'chart.png', 'x') })

    const result = await callToolWith(f, { ...f.session, cellId: 'claude-20261023-other' }, 'open', { name: 'chart.png' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('还是空的')
  })
})

describe('协议错误与通知', () => {
  it('通知（没有 id）一律不回，包括不认识的通知', async () => {
    const f = fixture()
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/whatever']) {
      expect(await f.handler.handle({ jsonrpc: '2.0', method }, f.session), method).toBeNull()
    }
  })

  it('不认识的方法：-32601，并且把方法名报回去', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 3, method: 'resources/list' })
    expect(reply.error).toMatchObject({ code: -32601 })
    expect((reply.error as { message: string }).message).toContain('resources/list')
  })

  it('ping 要回，不能报「没有这个方法」——客户端拿它探活', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 4, method: 'ping' })
    expect(reply.result).toEqual({})
    expect(reply.error).toBeUndefined()
  })

  it('不是对象 / 没有 method：-32600', async () => {
    const f = fixture()
    for (const message of ['hi', 42, null, [], { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, method: 7 }]) {
      const reply = await f.handler.handle(message, f.session)
      expect((reply as { error?: { code: number } }).error?.code, JSON.stringify(message)).toBe(-32600)
    }
  })

  it('tools/call 的 params 不是对象、name 不是字符串：-32602', async () => {
    const f = fixture()
    for (const params of [null, 'publish', [], { name: 7 }]) {
      const reply = await request(f, { jsonrpc: '2.0', id: 5, method: 'tools/call', params })
      expect((reply.error as { code: number }).code, JSON.stringify(params)).toBe(-32602)
    }
  })

  it('不存在的工具名：这是工具层面的错，并且把可用的两个列出来', async () => {
    const f = fixture()
    const result = await callTool(f, 'run_shell', { command: 'rm -rf /' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('run_shell')
    expect(result.text).toContain('publish')
    expect(result.text).toContain('open')
    // 连账本都不该被碰：没有任何动作发生过。
    expect(f.ledger.records).toHaveLength(0)
  })

  it('id 是字符串也照样回同一个 id——id 只是回声，不做别的用', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 'req-1', method: 'tools/list' })
    expect(reply.id).toBe('req-1')
  })

  it('回复里不该出现 jsonrpc 以外的顶层键', async () => {
    const f = fixture()
    const reply = await request(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(Object.keys(reply).sort()).toEqual(['id', 'jsonrpc', 'result'])
  })
})

describe('一次真实的往返', () => {
  it('握手 → 列表 → 交付 → 打开：会话记录原样长这样', async () => {
    // 这条用例同时是验收要的那份「原始 JSON-RPC 会话记录」的单测版本：
    // 它把四步串起来跑一遍，确认整条链路是通的。
    const f = fixture()

    const init = await request(f, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('abx')

    const list = await request(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(2)

    const published = await callTool(f, 'publish', { path: inCell(f, 'report.pdf', '%PDF-1.4 fake') })
    expect(published.isError).toBe(false)

    const opened = await callTool(f, 'open', { name: 'report.pdf' })
    expect(opened.isError).toBe(false)

    expect(f.ledger.records.map((line) => `${line.action}:${line.outcome}`)).toEqual(['publish:opened', 'open:opened'])
    expect(existsSync(path.join(path.dirname(f.taskDir), 'outbox', CELL_ID, 'report.pdf'))).toBe(true)
  })
})
