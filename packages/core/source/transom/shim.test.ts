/**
 * shim 的用例：**真的把它跑起来**。
 *
 * 这个文件里的每一件事都是真的——真的写一个 `.mjs` 到磁盘、真的 `spawn` node、
 * 真的起一个 HTTP 服务收它的请求。理由是这一层的失败方式全都只在「真的跑起来」
 * 时才出现：stdio 的分帧、stdout 上多了一个字节、宿主拒绝时被悄悄咽下去。
 *
 * 一个假不了的断言：**stdout 上每一行都必须是合法的 JSON-RPC 消息**。
 * 只要 shim 往 stdout 写了一句日志，这个用例就会红——而那正是最可能的改错方式。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_SHIM_FILE_NAME, TRANSOM_ENDPOINT_PATH, TRANSOM_SERVER_NAME } from '@abx/contracts'
import type { Opener } from './opener'
import { createMemoryTransomLedger } from './ledger'
import { createTransomMcpHandler } from './mcp'
import { createTransomService, type TransomSession } from './service'
import { RUNTIME_DIR_NAME, defaultRuntimeRoot, runtimeDirFor, stageTransomShim } from './shim'
import { RUNNING_VOCABULARY } from '../test-support'

/** 运行时根是**宿主路径**，形状跟着跑测试这台机器走（见 `test-support.ts`）。 */
const HOST = RUNNING_VOCABULARY

const CELL_ID = 'claude-20261023-abc123'
const CELL_TOKEN = 'abx_cell_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

interface Host {
  /** 舱内那个 shim 要连的地址。 */
  readonly origin: string
  readonly outboxRoot: string
  readonly taskDir: string
  /** 记录宿主这一侧看到的令牌，用来断言「shim 真的带了身份」。 */
  readonly tokens: string[]
  readonly session: TransomSession
}

interface StartHostOptions {
  /** 宿主认哪个令牌。默认认 `CELL_TOKEN`。 */
  readonly token?: string
}

/**
 * 一个**最小的宿主**：一个 HTTP 服务，把收到的 body 交给 `createTransomMcpHandler`。
 *
 * 它不是 broker 的那条路由（那条有自己的用例），这里只要「HTTP + MCP 处理器」
 * 这一层——它正好是 shim 的对端。
 */
async function startHost(options: StartHostOptions = {}): Promise<Host> {
  const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-shim-'))
  const taskDir = path.join(base, 'task')
  const outboxRoot = path.join(base, 'outbox')
  mkdirSync(taskDir)

  const tokens: string[] = []
  const session: TransomSession = {
    cellId: CELL_ID,
    agentId: 'claude',
    roots: [{ cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' }],
  }
  const opener: Opener = {
    name: 'stub-opener',
    openFile: () => Promise.resolve(),
    revealInFolder: () => Promise.resolve(),
  }
  const handler = createTransomMcpHandler({
    service: createTransomService({ outboxRoot, ledger: createMemoryTransomLedger(), opener }),
  })

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      void respond(request.url ?? '', request.headers['x-abx-cell'], Buffer.concat(chunks).toString('utf8'))
    })

    async function respond(url: string, header: string | string[] | undefined, body: string): Promise<void> {
      const presented = typeof header === 'string' ? header : ''
      tokens.push(presented)
      if (url !== TRANSOM_ENDPOINT_PATH) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      // 令牌不对就是 403。宿主这一侧的鉴权在真 broker 上由舱面那道闸做，
      // 这里只需要「会拒绝」这件事是真的——shim 对拒绝的反应才是被测的东西。
      if (presented !== (options.token ?? CELL_TOKEN)) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'abx_cell_token_denied' }))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'bad_json' }))
        return
      }
      const reply = await handler.handle(message, session)
      if (reply === null) {
        // 通知：受理但没有回复体。shim 必须据此**什么都不写**。
        response.writeHead(202)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))

  return { origin: `http://127.0.0.1:${port}`, outboxRoot, taskDir, tokens, session }
}

interface ShimRun {
  readonly replies: Record<string, unknown>[]
  /** stdout 上的原始行。用来断言「除了协议什么都没有」。 */
  readonly rawLines: string[]
  readonly stderr: string
  readonly exitCode: number | null
}

interface TalkOptions {
  readonly host: Host
  readonly messages: unknown[]
  /** 预期收到几条回复。收齐就关 stdin，不等超时。 */
  readonly replies: number
  /** 覆盖环境变量；不传就用宿主给的那三个。 */
  readonly env?: Record<string, string | undefined>
  /** 这个 shim 从哪个目录跑（默认新写一份）。 */
  readonly directory?: string
}

/** 把 shim 写到一个临时目录，跑起来，喂消息，收回复。 */
async function talk(options: TalkOptions): Promise<ShimRun> {
  const directory = options.directory ?? mkdtempSync(path.join(tmpdir(), 'abx-transom-run-'))
  if (options.directory === undefined) cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const staged = stageTransomShim({ directory })

  // `undefined` 表示「这次不注入它」——那是「舱里没有这个变量」那条用例要的。
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ABX_BROKER_ORIGIN: options.host.origin,
    ABX_CELL_TOKEN: CELL_TOKEN,
    ABX_CELL_ID: CELL_ID,
    ...options.env,
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(merged)) if (value !== undefined) env[name] = value

  const child = spawn(process.execPath, [staged.hostPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const rawLines: string[] = []
  const replies: Record<string, unknown>[] = []
  let stderr = ''
  let pending = ''

  const done = new Promise<void>((resolve) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      // 按行切：**一行就是一条消息**。分帧在这里，不在 shim 的用例里。
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        if (line.trim() !== '') {
          rawLines.push(line)
          replies.push(JSON.parse(line) as Record<string, unknown>)
        }
        index = pending.indexOf('\n')
      }
      if (replies.length >= options.replies) resolve()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', resolve)
  })

  for (const message of options.messages) child.stdin.write(`${JSON.stringify(message)}\n`)
  child.stdin.end()

  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20_000)),
  ])
  if (timedOut) {
    child.kill('SIGKILL')
    throw new Error(`shim 在 20 秒内只回了 ${replies.length} / ${options.replies} 条：${stderr}`)
  }
  const exitCode = child.exitCode
  if (exitCode === null) {
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  }

  return { replies, rawLines, stderr, exitCode: child.exitCode }
}

describe('一次真实的往返', () => {
  it('initialize → tools/list → publish → open，四步都通', async () => {
    const host = await startHost()
    const content = 'not-really-a-png'
    writeFileSync(path.join(host.taskDir, 'chart.png'), content)
    const digest = createHash('sha256').update(content).digest('hex')

    const run = await talk({
      host,
      replies: 4,
      messages: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'publish', arguments: { path: '/workspace/chart.png' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'open', arguments: { name: 'chart.png' } } },
      ],
    })

    expect(run.exitCode).toBe(0)
    expect(run.replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4])

    const init = run.replies[0]?.result as { serverInfo: { name: string }; protocolVersion: string }
    expect(init.serverInfo.name).toBe(TRANSOM_SERVER_NAME)
    expect(init.protocolVersion).toBe('2025-06-18')

    expect((run.replies[1]?.result as { tools: unknown[] }).tools).toHaveLength(2)

    const published = run.replies[2]?.result as { isError: boolean; content: { text: string }[] }
    expect(published.isError).toBe(false)
    expect(published.content[0]?.text).toContain(digest)
    // 舱内那一份与交付格里的那一份逐字节相同。
    expect(existsSync(path.join(host.outboxRoot, CELL_ID, 'chart.png'))).toBe(true)

    expect((run.replies[3]?.result as { isError: boolean }).isError).toBe(false)
    // 身份真的带过去了：每一次请求宿主都收到了这个舱的令牌。
    expect(host.tokens).toHaveLength(4)
    expect(new Set(host.tokens)).toEqual(new Set([CELL_TOKEN]))
  })

  it('拒绝也要真的送到 agent 手里：来源在舱外时 isError=true', async () => {
    const host = await startHost()
    const run = await talk({
      host,
      replies: 1,
      messages: [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish', arguments: { path: '/etc/passwd' } } },
      ],
    })

    const result = run.replies[0]?.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('不在这次会话的舱内目录里')
  })
})

describe('stdout 只走协议', () => {
  it('每一行都是合法的 JSON-RPC，一个字节的杂音都没有', async () => {
    const host = await startHost()
    const run = await talk({
      host,
      replies: 2,
      messages: [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
    })

    expect(run.rawLines).toHaveLength(2)
    for (const line of run.rawLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed.jsonrpc).toBe('2.0')
      expect(parsed.id).toBeDefined()
    }
  })

  it('通知（没有 id）不产生任何输出：回复的 id 对得上后面那条请求', async () => {
    const host = await startHost()
    const run = await talk({
      host,
      replies: 1,
      messages: [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      ],
    })

    // 只有一条输出，而且它是 id=7 那条——通知没有换来一行回复。
    expect(run.rawLines).toHaveLength(1)
    expect(run.replies[0]?.id).toBe(7)
  })

  it('不是 JSON 的一行：回 -32700，进程活着', async () => {
    const host = await startHost()
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-transom-run-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    stageTransomShim({ directory })

    const child = spawn(process.execPath, [path.join(directory, MCP_SHIM_FILE_NAME)], {
      env: { ...process.env, ABX_BROKER_ORIGIN: host.origin, ABX_CELL_TOKEN: CELL_TOKEN, ABX_CELL_ID: CELL_ID },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stdin.write('这不是 JSON\n')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    child.stdin.end()

    const exited = await new Promise<boolean>((resolve) => {
      child.on('close', () => resolve(true))
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 20_000)
    })

    expect(exited).toBe(true)
    expect(child.exitCode).toBe(0)
    const lines = out.trim().split('\n')
    // 解析错误的那一条 id 是 null，这正是 JSON-RPC 规定的形状。
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: null, error: { code: -32700 } })
    // 紧接着的那条 ping 照样被正常处理：坏消息不会把进程带走。
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ id: 1, result: {} })
  })
})

describe('宿主拒绝时，原因要看得见', () => {
  it('令牌不对（403）：把 HTTP 状态与原样带回来，不咽下去', async () => {
    const host = await startHost({ token: 'abx_cell_somethingelse' })
    const run = await talk({
      host,
      replies: 1,
      messages: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      env: { ABX_CELL_TOKEN: 'abx_cell_wrong' },
    })

    const error = run.replies[0]?.error as { code: number; message: string }
    expect(error.code).toBe(-32603)
    expect(error.message).toContain('403')
    expect(error.message).toContain('abx_cell_token_denied')
  })

  it('宿主根本没起：连不上，也要回一条说得清的错误', async () => {
    const host = await startHost()
    // 关掉服务，再让 shim 去连它。
    const run = await talk({
      host,
      replies: 1,
      messages: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      // 一个一定连不上的端口：1 号端口不会有人监听。
      env: { ABX_BROKER_ORIGIN: 'http://127.0.0.1:1' },
    })

    const error = run.replies[0]?.error as { code: number; message: string }
    expect(error.code).toBe(-32603)
    expect(error.message).toContain('连不上宿主上的传递窗')
    expect(error.message).toContain('这次调用没有发生')
  })

  it('舱里没注入环境变量：说清缺了哪一个，而不是静默失败', async () => {
    const host = await startHost()
    const run = await talk({
      host,
      replies: 1,
      messages: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      env: { ABX_BROKER_ORIGIN: undefined, ABX_CELL_TOKEN: undefined },
    })

    const error = run.replies[0]?.error as { code: number; message: string }
    expect(error.message).toContain('ABX_BROKER_ORIGIN')
    expect(error.message).toContain('ABX_CELL_TOKEN')
    // 一个请求都没发出去。
    expect(host.tokens).toEqual([])
  })
})

describe('落盘的地方', () => {
  it('stage 出来的是一个能直接 node 跑的文件，名字固定', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-transom-stage-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))

    const staged = stageTransomShim({ directory })

    expect(path.basename(staged.hostPath)).toBe(MCP_SHIM_FILE_NAME)
    expect(staged.hostPath).toBe(path.join(directory, MCP_SHIM_FILE_NAME))
    expect(staged.bytes).toBeGreaterThan(1000)
  })

  it('运行时根跟着 ABX_RUNTIME_ROOT / home 走，一格一个会话', () => {
    const custom = HOST.underHome('custom')
    expect(defaultRuntimeRoot({ ABX_RUNTIME_ROOT: custom }, HOST.home)).toBe(custom)
    expect(defaultRuntimeRoot({}, HOST.home)).toBe(HOST.underHome('.abx', RUNTIME_DIR_NAME))
    // 空串按「没配」处理，否则会得到一个空路径。
    expect(defaultRuntimeRoot({ ABX_RUNTIME_ROOT: '   ' }, HOST.home)).toBe(HOST.underHome('.abx', RUNTIME_DIR_NAME))

    const root = HOST.underHome('rt')
    expect(runtimeDirFor(root, CELL_ID)).toBe(HOST.join(root, CELL_ID))
    // 会话 id 来自宿主，但仍然过一遍清洗：它要当目录名用。
    expect(runtimeDirFor(root, '../../etc')).toBe(HOST.join(root, '.._.._etc'))
  })
})
