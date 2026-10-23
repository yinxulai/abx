/**
 * `parseConfig` 的用例。
 *
 * 最重要的一条在最上面：**把仓库里那份 `abx.config.json` 真的读一遍**。
 *
 * 为什么值得单列一条：在此之前，配置解析只有零散的单字段用例，而仓库里那份
 * 示例配置从来没被任何测试碰过。结果是它能通过全部 272 个用例，却在
 * `abx doctor` 上直接报错——注释里的 `${VAR}` 被当成真的引用展开、
 * `egress.allow` 的嵌套层级没被支持。这两个 bug 都是「只有拿真实文件跑一遍
 * 才会现形」的那一类，所以这条用例的价值不在于它断言了什么，
 * 而在于它**喂进去的是那个会被用户真正执行的文件**。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfig } from './load-config'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REPO_CONFIG_PATH = path.join(REPO_ROOT, 'abx.config.json')

function parse(raw: unknown, env: Record<string, string | undefined> = {}) {
  return parseConfig(raw, { env })
}

/** 加载成功时取出配置；失败就直接把问题列表抛出来，省得用例里到处 if。 */
function configOf(raw: unknown, env: Record<string, string | undefined> = {}) {
  const result = parse(raw, env)
  if (!result.ok) throw new Error(`预期加载成功，实际：${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
  return result.config
}

function issuesOf(raw: unknown, env: Record<string, string | undefined> = {}) {
  const result = parse(raw, env)
  if (result.ok) throw new Error('预期加载失败，实际成功了')
  return result.issues
}

function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    upstreams: [
      { id: 'anthropic', baseUrl: 'https://api.anthropic.com', authHeader: 'authorization', secretEnv: 'ANTHROPIC_API_KEY' },
    ],
    egress: { allow: [{ pattern: 'api.anthropic.com', upstreamId: 'anthropic' }] },
    ...overrides,
  }
}

describe('仓库里那份 abx.config.json', () => {
  const text = readFileSync(REPO_CONFIG_PATH, 'utf8')

  it('能加载（不设任何环境变量，全靠 :- 默认值）', () => {
    const config = configOf(JSON.parse(text), {})
    expect(config.upstreams.map((upstream) => upstream.id)).toEqual(['anthropic', 'openai', 'dsh'])
    expect(config.broker.cellHost).toBe('172.17.0.1')
    expect(config.broker.auditPath).toBe('./abx-audit.jsonl')
    expect(config.egress.length).toBeGreaterThan(0)
  })

  it('环境变量能覆盖默认值', () => {
    const config = configOf(JSON.parse(text), { ABX_CELL_HOST: '10.0.0.1', ABX_AUDIT_PATH: '/tmp/a.jsonl' })
    expect(config.broker.cellHost).toBe('10.0.0.1')
    expect(config.broker.auditPath).toBe('/tmp/a.jsonl')
  })

  it('里面没有任何明文密钥', () => {
    // 这条不是靠人工 review 保证的：示例配置里只要出现一个真钥匙，
    // 它就会被复制到所有人的机器上，然后被推到远端。
    expect(() => configOf(JSON.parse(text), {})).not.toThrow()
    // 顺手把「值里长得像密钥」的形状也挡一道，防止以后有人贴一个进来。
    expect(text).not.toMatch(/sk-ant-[A-Za-z0-9_-]{16,}/)
  })

  it('每个上游的域名都在白名单里（否则它的请求会全部 403）', () => {
    const config = configOf(JSON.parse(text), {})
    for (const upstream of config.upstreams) {
      const host = new URL(upstream.baseUrl).hostname
      const covered = config.egress.some((rule) => rule.pattern === host || rule.pattern === `.${host}` || rule.pattern === `*.${host}`)
      expect(covered, `${upstream.id} 的 ${host} 不在 egress.allow 里`).toBe(true)
    }
  })

  it('示例配置里写的凭据来源全是引用，不是值', () => {
    const config = configOf(JSON.parse(text), {})
    for (const upstream of config.upstreams) {
      expect(upstream.secretEnv ?? upstream.secretFile).toBeTruthy()
      expect(upstream.secretEnv === null || /^[A-Z_][A-Z0-9_]*$/.test(upstream.secretEnv)).toBe(true)
    }
  })
})

describe('$comment 是注释，不是配置', () => {
  it('注释里的 ${VAR} 不会因为没有值而报错', () => {
    // 项目自己的配置里就有一行注释在解释语法，写的是「可以用 ${VAR} 引用」。
    // 连注释一起展开的话，一份完全正确的配置会在启动时报「VAR 没有值」。
    const config = configOf({
      $comment: ['可以用 ${VAR} 或 ${VAR:-默认值} 引用环境变量'],
      ...minimalConfig(),
    })
    expect(config.egress).toHaveLength(1)
  })

  it('注释里举例的密钥形状不会被当成真密钥', () => {
    // 「别在这里写 sk-ant-xxxx」这句注释本身不该触发明文密钥拦截。
    const config = configOf({
      $comment: '别在这里写 sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa',
      ...minimalConfig(),
    })
    expect(config.upstreams).toHaveLength(1)
  })

  it('注释不会被塞进解析结果里', () => {
    const config = configOf({
      broker: { $comment: '端口说明', hostPort: 9999, cellPort: 9998 },
      ...minimalConfig(),
    })
    expect(config.broker.hostPort).toBe(9999)
    expect(Object.keys(config.broker)).not.toContain('$comment')
  })
})

describe('egress.allow 的形状', () => {
  it('字符串写法不绑上游', () => {
    const config = configOf({
      upstreams: [],
      egress: { allow: ['api.example.com'] },
    })
    expect(config.egress).toEqual([{ pattern: 'api.example.com', upstreamId: null }])
  })

  it('对象写法绑上游', () => {
    const config = configOf(minimalConfig())
    expect(config.egress).toEqual([{ pattern: 'api.anthropic.com', upstreamId: 'anthropic' }])
  })

  it('两种写法可以混着写', () => {
    const config = configOf({
      upstreams: [
        { id: 'anthropic', baseUrl: 'https://api.anthropic.com', authHeader: 'authorization', secretEnv: 'K' },
      ],
      egress: { allow: ['api.example.com', { pattern: 'api.anthropic.com', upstreamId: 'anthropic' }] },
    })
    expect(config.egress).toHaveLength(2)
  })

  it('整个 egress 段不写就是空名单', () => {
    const config = configOf({ upstreams: [] })
    expect(config.egress).toEqual([])
  })

  it('写了 egress 但不写 allow 也是空名单', () => {
    const config = configOf({ upstreams: [], egress: {} })
    expect(config.egress).toEqual([])
  })

  it('allow 不是数组时报错，且报错路径指到 allow 上', () => {
    const issues = issuesOf({ upstreams: [], egress: { allow: 'api.example.com' } })
    expect(issues.map((issue) => issue.path)).toContain('egress.allow')
  })

  it('域名归一化成小写，避免同一域名看起来是两条规则', () => {
    const config = configOf({ upstreams: [], egress: { allow: ['API.Example.COM'] } })
    expect(config.egress[0]?.pattern).toBe('api.example.com')
  })

  it('裸 * 被拒绝', () => {
    const issues = issuesOf({ upstreams: [], egress: { allow: ['*'] } })
    expect(issues).toHaveLength(1)
  })

  it('域名重复会报错', () => {
    const issues = issuesOf({ upstreams: [], egress: { allow: ['api.example.com', 'api.example.com'] } })
    expect(issues.some((issue) => issue.message.includes('重复'))).toBe(true)
  })
})

describe('交叉校验', () => {
  it('上游域名不在白名单里，直接指出这个上游的请求会全部 403', () => {
    const issues = issuesOf({
      upstreams: [{ id: 'x', baseUrl: 'https://api.notallowed.com', authHeader: 'authorization', secretEnv: 'K' }],
      egress: { allow: ['api.example.com'] },
    })
    expect(issues[0]?.path).toBe('upstreams[0].baseUrl')
    expect(issues[0]?.message).toContain('403')
  })

  it('egress 绑了一个不存在的上游 id', () => {
    const issues = issuesOf({
      upstreams: [],
      egress: { allow: [{ pattern: 'api.example.com', upstreamId: 'ghost' }] },
    })
    expect(issues[0]?.path).toBe('egress.allow[0].upstreamId')
  })

  it('通配规则也算覆盖', () => {
    const config = configOf({
      upstreams: [{ id: 'x', baseUrl: 'https://api.anthropic.com', authHeader: 'authorization', secretEnv: 'K' }],
      egress: { allow: [{ pattern: '*.anthropic.com', upstreamId: 'x' }] },
    })
    expect(config.upstreams).toHaveLength(1)
  })
})

describe('凭据来源必须是引用', () => {
  it('secretEnv 和 secretFile 都不写就报错', () => {
    const issues = issuesOf({
      upstreams: [{ id: 'x', baseUrl: 'https://api.example.com', authHeader: 'authorization' }],
      egress: { allow: ['api.example.com'] },
    })
    expect(issues[0]?.message).toContain('secretEnv')
  })

  it('两个都写也报错', () => {
    const issues = issuesOf({
      upstreams: [
        { id: 'x', baseUrl: 'https://api.example.com', authHeader: 'authorization', secretEnv: 'K', secretFile: '/k' },
      ],
      egress: { allow: ['api.example.com'] },
    })
    expect(issues[0]?.message).toContain('只能写一个')
  })

  it('把密钥直接写进 secretEnv 会被拦下来', () => {
    // 最危险的一种写法：键名合法，值是真钥匙，读配置的人会以为它是个变量名。
    const issues = issuesOf({
      upstreams: [
        {
          id: 'x',
          baseUrl: 'https://api.example.com',
          authHeader: 'authorization',
          secretEnv: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        },
      ],
      egress: { allow: ['api.example.com'] },
    })
    expect(issues[0]?.message).toContain('明文密钥')
    // 报错信息本身不能变成泄漏渠道。
    expect(issues[0]?.message).not.toContain('abcdefghijklmnop')
  })

  it('键名叫 secret 的字段一律被拦', () => {
    const issues = issuesOf({
      upstreams: [{ id: 'x', baseUrl: 'https://api.example.com', authHeader: 'authorization', secret: 'hunter2' }],
      egress: { allow: ['api.example.com'] },
    })
    expect(issues[0]?.path).toBe('upstreams[0].secret')
  })
})

describe('环境变量引用', () => {
  it('没写默认值又没有值时，报错里带上变量名', () => {
    const issues = issuesOf({
      broker: { cellHost: '${ABX_MISSING_HOST}' },
      ...minimalConfig(),
    })
    expect(issues[0]?.message).toContain('ABX_MISSING_HOST')
  })

  it('有默认值时用默认值', () => {
    const config = configOf({ broker: { cellHost: '${ABX_NOPE:-10.1.2.3}' }, ...minimalConfig() })
    expect(config.broker.cellHost).toBe('10.1.2.3')
  })

  it('环境里有值时优先用环境里的', () => {
    const config = configOf({ broker: { cellHost: '${ABX_HOST:-10.1.2.3}' }, ...minimalConfig() }, { ABX_HOST: '192.168.1.1' })
    expect(config.broker.cellHost).toBe('192.168.1.1')
  })

  it('展开后是数字的端口能通过形状校验', () => {
    // 展开必须在形状校验之前，否则 "${ABX_PORT}" 这种写法永远是错的。
    const config = configOf({ broker: { hostPort: '${ABX_PORT}', cellPort: 9999 }, ...minimalConfig() }, { ABX_PORT: '8123' })
    expect(config.broker.hostPort).toBe(8123)
  })
})

describe('其他形状校验', () => {
  it('宿主面和舱面端口相同会被拦，而不是等到 listen 时才 EADDRINUSE', () => {
    const issues = issuesOf({ broker: { hostPort: 8788, cellPort: 8788 }, ...minimalConfig() })
    expect(issues[0]?.path).toBe('broker.cellPort')
  })

  it('backend 只能是 docker 或 local', () => {
    const issues = issuesOf({ session: { backend: 'firecracker' }, ...minimalConfig() })
    expect(issues[0]?.path).toBe('session.backend')
  })

  it('不写 session 时默认是 docker，不是 local', () => {
    // 默认 local 等于默认没有沙箱。这条断言钉的是「默认安全」这个性质。
    const config = configOf(minimalConfig())
    expect(config.session.backend).toBe('docker')
  })

  it('一次报出多个问题，而不是修一个跑一次', () => {
    const issues = issuesOf({
      broker: { hostPort: 1, cellPort: 1 },
      session: { backend: 'nope' },
      upstreams: [],
    })
    expect(issues.length).toBeGreaterThanOrEqual(2)
  })
})
