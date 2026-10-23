/**
 * local 后端那条路上的舱面来源。
 *
 * local 后端的「舱」就跑在宿主上（`resolveCellHost` 把舱面绑到 `127.0.0.1`），
 * 来源地址是回环。默认的允许网段里必须有回环，否则一个请求都进不来，而报错只说
 * 「来源地址不在允许的网段内」，看不出是哪个开关的问题——所以这里真的起一个
 * broker 打一遍，而不是只断言常量。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig } from '@abx/contracts/test-support'
import { DEFAULT_ALLOWED_CELL_SUBNETS, createMemoryAuditSink, startBroker, type BrokerHandle } from '../broker/index'
import { resolveCellHost } from './runtime'

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
