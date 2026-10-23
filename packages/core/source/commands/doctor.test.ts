import { describe, expect, it, vi } from 'vitest'
import { makeConfig, makeEgressRule, makeUpstream } from '@abx/contracts/test-support'
import { RUNNING_PLATFORM } from '../test-support'
import type { CommandOptions } from './options'
import type { CommandContext } from './runtime'
import { collectChecks, findDangerousHostEnv } from './doctor'

/*
 * 这一份的用例**不是纯函数**：`collectChecks` 会真的去问这台机器——找可执行文件、
 * 起 docker 客户端、试绑端口、看 user namespace。所以它花多久取决于跑它的那台机器，
 * 而默认的 5 秒是照着一台空闲 Linux 机器定的。
 *
 * Windows runner 上实测超时（39966247380 的 Windows job：`Test timed out in 5000ms`），
 * 那里起一次进程要贵得多，而 PATH 还是要一段一段扫的。**升的是超时，不是断言**：
 * 每一条仍然按原样跑、按原样判，只是不再用一台快机器的秒数去卡另一台慢机器。
 * 真挂住的话仍然有 CI job 自己的超时兜着，不会变成「永远转圈」。
 */
vi.setConfig({ testTimeout: 30_000 })

function context(overrides: Parameters<typeof makeConfig>[0] = {}, env: Record<string, string | undefined> = {}): CommandContext {
  return {
    config: makeConfig(overrides),
    configPath: '/tmp/abx.config.json',
    env,
    cwd: '/tmp',
    // 这几条命令的用例不碰文件系统，只验编排与文案，所以 cwd / configPath 用固定
    // 字符串就够（doctor 只把它们打印出来）。平台倒是必须给：它决定路径规则，
    // 而路径规则决定「哪些配置被判成危险」。跑测试这台机器就是它。
    platform: RUNNING_PLATFORM,
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

  it('local 后端下舱面固定走回环，且不探测', async () => {
    const checks = await collectChecks(context(), options({ backend: 'local' }))
    const cellHost = await checkNamed(checks, '舱面地址')
    expect(cellHost.detail).toContain('127.0.0.1')
    expect(cellHost.detail).toContain('不探测')
  })

  it('docker 后端下，「告诉舱内哪个地址」与「宿主绑哪张网卡」要分开报', async () => {
    // 这两件事以前是同一个值，所以只报一个数字就够了。现在默认值是
    // `host.docker.internal` —— 那是**舱内的**名字，宿主上并不存在，
    // 于是「绑在 host.docker.internal」这句话本身就不成立。
    const checks = await collectChecks(context(), options({ backend: 'docker' }))
    const cellHost = await checkNamed(checks, '舱面地址')
    expect(cellHost.detail).toContain('告诉舱内 host.docker.internal')
    // 名字不能当 bind 候选：直接退到 0.0.0.0，而这件事必须写在检查项里。
    expect(cellHost.detail).toContain('宿主绑 0.0.0.0')
  })

  it('配成 172.17.0.1 时给出提醒，并说清它在哪些平台上不存在', async () => {
    const checks = await collectChecks(context({ broker: { cellHost: '172.17.0.1' } }), options({ backend: 'docker' }))
    const cellHost = await checkNamed(checks, '舱面地址')
    expect(cellHost.status).toBe('warn')
    expect(cellHost.detail).toContain('宿主绑 172.17.0.1 → 0.0.0.0')
    expect(cellHost.hint).toContain('Docker Desktop')
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
