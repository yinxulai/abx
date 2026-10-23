/**
 * local 后端那条路上的舱面来源。
 *
 * local 后端的「舱」就跑在宿主上（`resolveCellHost` 把舱面绑到 `127.0.0.1`），
 * 来源地址是回环。默认的允许网段里必须有回环，否则一个请求都进不来，而报错只说
 * 「来源地址不在允许的网段内」，看不出是哪个开关的问题——所以这里真的起一个
 * broker 打一遍，而不是只断言常量。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig } from '@abx/contracts/test-support'
import { DEFAULT_ALLOWED_CELL_SUBNETS, createMemoryAuditSink, startBroker, type BrokerHandle } from '../broker/index'
import type { Opener } from '../transom/opener'
import { outboxDirFor } from '../transom/outbox'
import type { TransomSession } from '../transom/service'
import { createTransomRuntime, resolveCellHost } from './runtime'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function startLocalBroker(allowedCellSubnets?: readonly string[]): Promise<BrokerHandle> {
  const config = makeConfig()
  const handle = await startBroker({
    config,
    env: {},
    cellToken: 'abx_cell_local-backend-0000',
    cellHost: resolveCellHost(config, 'local', null),
    // 不传审计 sink 的话，broker 会按配置里的相对路径往**当前目录**写审计流水。
    // 跑测试时的当前目录是仓库根，那会在工作区里留下一个 abx-audit.jsonl。
    auditSink: createMemoryAuditSink(),
    ...(allowedCellSubnets === undefined ? {} : { allowedCellSubnets }),
    hostPort: 0,
    cellPort: 0,
    logger: quiet,
  })
  cleanups.push(() => handle.close())
  return handle
}

describe('local 后端的舱面来源', () => {
  it('舱面绑在回环上', () => {
    expect(resolveCellHost(makeConfig(), 'local', null)).toBe('127.0.0.1')
  })

  it('回环在默认允许网段里', () => {
    expect(DEFAULT_ALLOWED_CELL_SUBNETS).toContain('127.0.0.1/32')
  })

  it('用默认网段起的 broker：回环来源能连上舱面', async () => {
    const handle = await startLocalBroker()
    const response = await fetch(`${handle.cellOrigin}/healthz`, { headers: { 'x-abx-cell': handle.cellToken } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('允许列表里没有回环时，本地来源连健康检查都进不去', async () => {
    const handle = await startLocalBroker(['192.168.65.0/24'])
    const response = await fetch(`${handle.cellOrigin}/healthz`, { headers: { 'x-abx-cell': handle.cellToken } })

    expect(response.status).toBe(403)
  })
})

/**
 * `createTransomRuntime`：把交付根、账本、打开方式拼成一个处理器。
 *
 * 这里用的是**真的**文件账本与真的文件系统（只是落在临时目录里），因为「交付格里的
 * 每一个文件都有一条账」是产品承诺，而承诺的对象就是那两样东西。打开动作照例是替身：
 * 它会在宿主上真的弹窗。
 */
describe('createTransomRuntime', () => {
  const CELL_ID = 'claude-20261023-runtime001'

  interface Fixture {
    readonly env: Record<string, string>
    readonly taskDir: string
    readonly outboxRoot: string
    readonly ledgerPath: string
    readonly calls: string[]
    readonly opener: Opener
  }

  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fixture(): Fixture {
    const base = mkdtempSync(path.join(tmpdir(), 'abx-transom-runtime-'))
    tempDirs.push(base)
    const taskDir = path.join(base, 'task')
    const outboxRoot = path.join(base, 'outbox')
    const ledgerPath = path.join(base, 'transom.jsonl')
    mkdirSync(taskDir, { recursive: true })

    const calls: string[] = []
    return {
      env: { ABX_OUTBOX_ROOT: outboxRoot, ABX_TRANSOM_LEDGER: ledgerPath },
      taskDir,
      outboxRoot,
      ledgerPath,
      calls,
      opener: {
        name: 'stub-opener',
        openFile: (absolutePath: string) => {
          calls.push(`open:${absolutePath}`)
          return Promise.resolve()
        },
        revealInFolder: (absolutePath: string) => {
          calls.push(`reveal:${absolutePath}`)
          return Promise.resolve()
        },
      },
    }
  }

  function sessionOf(taskDir: string): TransomSession {
    return { cellId: CELL_ID, agentId: 'claude', roots: [{ cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' }] }
  }

  function publishCall(cellPath: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish', arguments: { path: cellPath } } }
  }

  it('交付根与账本都跟着环境变量走，不碰真实的 ~/.abx', () => {
    const f = fixture()
    const runtime = createTransomRuntime({ env: f.env, opener: f.opener })

    expect(runtime.outboxRoot).toBe(path.resolve(f.outboxRoot))
    expect(runtime.ledgerPath).toBe(path.resolve(f.ledgerPath))
    expect(runtime.openerName).toBe('stub-opener')
  })

  it('处理器真的接上了：initialize 回我们的名字，工具列表就是那两个', async () => {
    const f = fixture()
    const runtime = createTransomRuntime({ env: f.env, opener: f.opener })

    const handshake = (await runtime.handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, sessionOf(f.taskDir))) as {
      result: { serverInfo: { name: string } }
    }
    const list = (await runtime.handler.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionOf(f.taskDir))) as {
      result: { tools: { name: string }[] }
    }

    expect(handshake.result.serverInfo.name).toBe('abx')
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['publish', 'open'])
  })

  it('交付一次：文件进交付格、账本落一行、sha256 与内容对得上', async () => {
    const f = fixture()
    const runtime = createTransomRuntime({ env: f.env, opener: f.opener })
    const content = 'hello from the cell'
    writeFileSync(path.join(f.taskDir, 'report.png'), content)

    const reply = await runtime.handler.handle(publishCall('/workspace/report.png'), sessionOf(f.taskDir))
    await runtime.close()

    const deliveredPath = path.join(outboxDirFor(runtime.outboxRoot, CELL_ID), 'report.png')
    expect(readFileSync(deliveredPath, 'utf8')).toBe(content)
    expect(f.calls).toEqual([`open:${deliveredPath}`])

    // 账本是**真的文件**：一行一条，字段逐项写死。
    const lines = readFileSync(f.ledgerPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      cellId: CELL_ID,
      agentId: 'claude',
      action: 'publish',
      outcome: 'opened',
      hostPath: deliveredPath,
      sha256: createHash('sha256').update(content).digest('hex'),
      disposition: 'open',
      opened: true,
      openedWith: 'stub-opener',
    })
    expect(reply).not.toBeNull()
  })

  it('宿主上没有「打开文件」这回事时：照样交付，只是没人替你打开', async () => {
    const f = fixture()
    const runtime = createTransomRuntime({ env: f.env, opener: null })
    writeFileSync(path.join(f.taskDir, 'report.png'), 'x')

    const reply = (await runtime.handler.handle(publishCall('/workspace/report.png'), sessionOf(f.taskDir))) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    await runtime.close()

    expect(runtime.openerName).toBeNull()
    expect(reply.result.isError).toBe(false)
    expect(reply.result.content[0]?.text).toContain('没能打开')
    expect(readFileSync(f.ledgerPath, 'utf8')).toContain('"outcome":"delivered"')
  })

  it('白名单之外的类型只显示、不打开，而且这一条也记账', async () => {
    const f = fixture()
    const runtime = createTransomRuntime({ env: f.env, opener: f.opener })
    writeFileSync(path.join(f.taskDir, 'setup.sh'), 'echo hi')

    const reply = (await runtime.handler.handle(publishCall('/workspace/setup.sh'), sessionOf(f.taskDir))) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    await runtime.close()

    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.startsWith('reveal:')).toBe(true)
    expect(reply.result.content[0]?.text).toContain('没有自动打开')
    expect(readFileSync(f.ledgerPath, 'utf8')).toContain('"outcome":"revealed"')
  })
})
