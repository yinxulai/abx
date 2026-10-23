import { describe, expect, it } from 'vitest'
import { makeConfig, makeEgressRule, makeUpstream } from '@abx/contracts/test-support'
import type { CommandOptions } from './options'
import type { CommandContext } from './runtime'
import { collectChecks, findDangerousHostEnv } from './doctor'

function context(overrides: Parameters<typeof makeConfig>[0] = {}, env: Record<string, string | undefined> = {}): CommandContext {
  return {
    config: makeConfig(overrides),
    configPath: '/tmp/abx.config.json',
    env,
    cwd: '/tmp',
  }
}

function options(overrides: Partial<CommandOptions> = {}): CommandOptions {
  return {
    positionals: [],
    configPath: null,
    backend: null,
    json: false,
    tail: false,
    dryRun: false,
    instance: null,
    cellHost: null,
    tokenFile: null,
    ...overrides,
  }
}

interface NamedCheck {
  readonly name: string
}

async function checkNamed(checks: readonly NamedCheck[], name: string) {
  const found = checks.find((check) => check.name === name)
  if (found === undefined) throw new Error(`没有名为 ${name} 的检查项`)
  return found as { name: string; status: string; detail: string; hint?: string }
}

describe('collectChecks', () => {
  it('每一项都有名字、状态和说明', async () => {
    const checks = await collectChecks(context(), options())
    expect(checks.length).toBeGreaterThan(5)
    for (const check of checks) {
      expect(check.name.length).toBeGreaterThan(0)
      expect(['ok', 'warn', 'fail']).toContain(check.status)
      expect(check.detail.length).toBeGreaterThan(0)
    }
  })

  it('local 后端被判成 fail —— 它不是沙箱', async () => {
    const checks = await collectChecks(context(), options({ backend: 'local' }))
    const backend = await checkNamed(checks, '沙箱后端')
    expect(backend.status).toBe('fail')
    expect(backend.detail).toContain('不是沙箱')
    expect(backend.hint).toBeDefined()
  })

  it('docker 后端在 docker 可用性未知时不因为后端本身失败', async () => {
    const checks = await collectChecks(context(), options({ backend: 'docker' }))
    // docker 起没起来取决于跑测试的机器，所以只断言「后端这一项本身是 ok」。
    expect((await checkNamed(checks, '沙箱后端')).status).toBe('ok')
  })

  it('空白名单提示「全部拒绝」，并且不把它当成错误', async () => {
    const checks = await collectChecks(context({ egress: [] }), options())
    const egress = await checkNamed(checks, '出口白名单')
    expect(egress.status).toBe('warn')
    expect(egress.detail).toContain('403')
  })

  it('通配白名单会被点名', async () => {
    const checks = await collectChecks(
      context({ egress: [makeEgressRule({ pattern: '*.example.com' }), makeEgressRule({ pattern: 'api.a.com' })] }),
      options(),
    )
    const egress = await checkNamed(checks, '出口白名单')
    expect(egress.status).toBe('warn')
    expect(egress.detail).toContain('*.example.com')
  })

  it('全精确域名的白名单是 ok', async () => {
    const checks = await collectChecks(context({ egress: [makeEgressRule({ pattern: 'api.a.com' })] }), options())
    expect((await checkNamed(checks, '出口白名单')).status).toBe('ok')
  })

  it('凭据没设置时失败，且报的是变量名不是值', async () => {
    const checks = await collectChecks(
      context({
        upstreams: [makeUpstream({ id: 'a', baseUrl: 'https://api.a.com', secretEnv: 'A_KEY' })],
        egress: [makeEgressRule({ pattern: 'api.a.com', upstreamId: 'a' })],
      }),
      options(),
    )
    const credentials = await checkNamed(checks, '上游凭据')
    expect(credentials.status).toBe('fail')
    expect(credentials.detail).toContain('A_KEY')
  })

  it('凭据就位时不读取值，只报存在性', async () => {
    const checks = await collectChecks(
      context(
        {
          upstreams: [makeUpstream({ id: 'a', baseUrl: 'https://api.a.com', secretEnv: 'A_KEY' })],
          egress: [makeEgressRule({ pattern: 'api.a.com', upstreamId: 'a' })],
        },
        { A_KEY: 'sk-ant-super-secret-value' },
      ),
      options(),
    )
    const credentials = await checkNamed(checks, '上游凭据')
    expect(credentials.status).toBe('ok')
    expect(credentials.detail).not.toContain('super-secret')
  })

  it('舱令牌只报长度，不报值', async () => {
    const checks = await collectChecks(context({}, { ABX_CELL_TOKEN: 'abcdef123456' }), options())
    const token = await checkNamed(checks, '舱令牌')
    expect(token.status).toBe('ok')
    expect(token.detail).toContain('12 字符')
    expect(token.detail).not.toContain('abcdef123456')
  })

  it('local 后端下舱面绑定地址固定是回环', async () => {
    const checks = await collectChecks(context(), options({ backend: 'local' }))
    const cellHost = await checkNamed(checks, '舱面绑定地址')
    expect(cellHost.detail).toContain('127.0.0.1')
  })

  it('挂载策略检查项复述的是策略对象里的那句话', async () => {
    const checks = await collectChecks(context(), options())
    const mount = await checkNamed(checks, '挂载策略')
    expect(mount.status).toBe('ok')
    expect(mount.detail).toContain('任务目录')
  })

  it('审计路径指向不存在的目录时只是提醒', async () => {
    const checks = await collectChecks(
      context({ broker: { auditPath: '/definitely/not/here/audit.jsonl' } }),
      options(),
    )
    const audit = await checkNamed(checks, '审计落盘')
    expect(audit.status).toBe('warn')
  })
})

describe('findDangerousHostEnv', () => {
  it('只报名，不报值', () => {
    const found = findDangerousHostEnv({ SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh', PATH: '/usr/bin' })
    expect(found).toEqual(['SSH_AUTH_SOCK'])
  })

  it('没有时是空数组', () => {
    expect(findDangerousHostEnv({ PATH: '/usr/bin' })).toEqual([])
  })
})
