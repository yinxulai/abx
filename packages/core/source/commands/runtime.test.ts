/**
 * 「舱面能接受哪些来源」在命令这一层的落点。
 *
 * 单说 `allowedCellSubnetsFor` 是个三行的函数，但它是 local 后端与默认网段之间
 * 唯一的接缝：接错了的表现是**一条请求都进不来**（全是 403），而报错只说
 * 「来源地址不在允许的网段内」，看不出是哪个开关的问题。所以这里既验判据，
 * 也真的起一个 broker 打一遍。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig } from '@abx/contracts/test-support'
import {
  DEFAULT_ALLOWED_CELL_SUBNETS,
  LOOPBACK_SUBNET,
  createMemoryAuditSink,
  startBroker,
  type BrokerHandle,
} from '../broker/index'
import { allowedCellSubnetsFor, resolveCellHost } from './runtime'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe('allowedCellSubnetsFor', () => {
  it('舱面绑在回环上时，允许列表里要有回环', () => {
    expect(allowedCellSubnetsFor('127.0.0.1')).toContain(LOOPBACK_SUBNET)
    // 整个 127.0.0.0/8 都是回环，不只是 .1。
    expect(allowedCellSubnetsFor('127.0.0.5')).toContain(LOOPBACK_SUBNET)
  })

  it('绑网桥地址时不多放任何东西', () => {
    expect(allowedCellSubnetsFor('0.0.0.0')).toEqual(DEFAULT_ALLOWED_CELL_SUBNETS)
    expect(allowedCellSubnetsFor('172.17.0.1')).toEqual(DEFAULT_ALLOWED_CELL_SUBNETS)
    expect(allowedCellSubnetsFor('192.168.65.2')).toEqual(DEFAULT_ALLOWED_CELL_SUBNETS)
  })

  it('local 后端的舱面地址走的就是回环那条路', () => {
    const config = makeConfig()
    const cellHost = resolveCellHost(config, 'local', null)

    expect(cellHost).toBe('127.0.0.1')
    expect(allowedCellSubnetsFor(cellHost)).toContain('127.0.0.1/32')
  })

  it('local 后端起的 broker：回环来源能连上舱面', async () => {
    const config = makeConfig({ upstreams: [], egress: [] })
    const cellHost = resolveCellHost(config, 'local', null)

    const handle: BrokerHandle = await startBroker({
      config,
      env: {},
      cellToken: 'abx_cell_local-backend-0000',
      cellHost,
      allowedCellSubnets: allowedCellSubnetsFor(cellHost),
      // 不传审计 sink 的话，broker 会按配置里的相对路径往**当前目录**写审计流水。
      // 跑测试时的当前目录是仓库根，那会在工作区里留下一个 abx-audit.jsonl。
      auditSink: createMemoryAuditSink(),
      hostPort: 0,
      cellPort: 0,
      logger: quiet,
    })
    cleanups.push(() => handle.close())

    const response = await fetch(`${handle.cellOrigin}/healthz`, { headers: { 'x-abx-cell': handle.cellToken } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('反过来：允许列表里没有回环时，本地来源连健康检查都进不去', async () => {
    const config = makeConfig({ upstreams: [], egress: [] })
    const handle: BrokerHandle = await startBroker({
      config,
      env: {},
      cellToken: 'abx_cell_local-backend-0000',
      cellHost: '127.0.0.1',
      allowedCellSubnets: ['192.168.65.0/24'],
      auditSink: createMemoryAuditSink(),
      hostPort: 0,
      cellPort: 0,
      logger: quiet,
    })
    cleanups.push(() => handle.close())

    const response = await fetch(`${handle.cellOrigin}/healthz`, { headers: { 'x-abx-cell': handle.cellToken } })

    expect(response.status).toBe(403)
  })
})
