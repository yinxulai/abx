import { describe, expect, it } from 'vitest'
import { findAgent } from '@abx/contracts'
import { buildCellEnv, generateCellId, scrubEnv } from './env'

const claude = findAgent('claude')
if (claude === null) throw new Error('agent 注册表里应当有 claude')

describe('scrubEnv', () => {
  it('剃掉配置里点名的凭据来源', () => {
    const result = scrubEnv(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-real', OPENAI_API_KEY: 'sk-real' },
      { forbiddenNames: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] },
    )
    expect(result.env).toEqual({ PATH: '/usr/bin' })
    expect(result.env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(result.removed).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
  })

  it('剃掉名字像凭据的变量（启发式兜底）', () => {
    const result = scrubEnv({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_x',
      NPM_TOKEN: 'npm_x',
      MY_API_KEY: 'x',
      DB_PASSWORD: 'x',
      SOME_SECRET: 'x',
      AWS_ACCESS_KEY: 'x-content',
      SAFE_VARIABLE: 'keep',
    })
    expect(result.env['SAFE_VARIABLE']).toBe('keep')
    for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'MY_API_KEY', 'DB_PASSWORD', 'SOME_SECRET', 'AWS_ACCESS_KEY']) {
      expect(result.env[name], `${name} 应当被剃掉`).toBeUndefined()
    }
  })

  it('剃掉宿主上危险但名字不像凭据的变量', () => {
    // ssh-agent 的 socket 排第一：有了它，舱内能以宿主用户身份用宿主的 SSH 私钥。
    const result = scrubEnv({
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      KUBECONFIG: '/home/me/.kube/config',
      LD_PRELOAD: '/evil.so',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/me/gcp.json',
    })
    expect(result.env).toEqual({ PATH: '/usr/bin' })
    expect(result.removed).toContain('SSH_AUTH_SOCK')
    expect(result.removed).toContain('DOCKER_HOST')
    expect(result.removed).toContain('KUBECONFIG')
  })

  it('overrides 里的名字跳过脱敏，因为那是我们马上要写进去的值', () => {
    // ANTHROPIC_AUTH_TOKEN 撞上 `_TOKEN` 模式，但它本来就该被占位符覆盖。
    const result = scrubEnv(
      { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'host-value' },
      { overrides: { ANTHROPIC_AUTH_TOKEN: 'abx-placeholder-anthropic' } },
    )
    expect(result.env['ANTHROPIC_AUTH_TOKEN']).toBe('abx-placeholder-anthropic')
  })

  it('removed 里只有变量名，没有值', () => {
    const result = scrubEnv({ GITHUB_TOKEN: 'ghp_verysecret' })
    expect(JSON.stringify(result.removed)).not.toContain('ghp_verysecret')
  })

  it('undefined 值的变量不会被写成字符串 "undefined"', () => {
    const result = scrubEnv({ PATH: '/usr/bin', MAYBE: undefined })
    expect(Object.keys(result.env)).toEqual(['PATH'])
  })

  it('空环境给空结果', () => {
    expect(scrubEnv({}).env).toEqual({})
  })
})

describe('buildCellEnv', () => {
  const base = {
    brokerCellOrigin: 'http://172.17.0.1:8789',
    cellId: 'cell-1',
    cellToken: 'tok-abc',
    upstreamId: 'anthropic',
  }

  it('baseUrl 指向 broker 舱面的上游路由', () => {
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: false })
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://172.17.0.1:8789/u/anthropic')
  })

  it('token 是占位符，不是真凭据', () => {
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: false })
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('abx-placeholder-anthropic')
  })

  it('带上会话信息，便于排查和审计', () => {
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: false })
    expect(env['ABX_CELL_ID']).toBe('cell-1')
    expect(env['ABX_CELL_TOKEN']).toBe('tok-abc')
    expect(env['ABX_BROKER_ORIGIN']).toBe('http://172.17.0.1:8789')
    expect(env['ABX_UPSTREAM_ID']).toBe('anthropic')
  })

  it('tokenInPath 时把令牌写进 baseUrl——但只对没法自定义请求头的 agent', () => {
    const codex = findAgent('codex')
    if (codex === null) throw new Error('注册表里应当有 codex')
    const env = buildCellEnv({ ...base, agent: codex, upstreamId: 'openai', tokenInPath: true })
    expect(env['OPENAI_BASE_URL']).toBe('http://172.17.0.1:8789/c/tok-abc/u/openai')
  })

  it('能自己加请求头的 agent 即使配置允许，也不把令牌写进 URL', () => {
    // 两个机制同时开着并不更安全（broker 只认一份令牌），只是让令牌白多出现在
    // 一个地方——而 URL 是最容易被 agent 自己打印、被上游 access log 收走的那个。
    // 这个行为是被真实链路跑出来的：之前两者都开着，写出来的 URL 里带前缀、
    // 请求头里也带令牌，看起来"冗余但无害"，实际上 header 优先那条规则会把
    // 前缀留在路径上，整条请求直接变成无效路由。
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: true })
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://172.17.0.1:8789/u/anthropic')
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Abx-Cell: tok-abc\nX-Abx-Cell-Id: cell-1')
  })

  it('配置里关掉路径前缀时，谁都别想走 URL', () => {
    const codex = findAgent('codex')
    if (codex === null) throw new Error('注册表里应当有 codex')
    const env = buildCellEnv({ ...base, agent: codex, upstreamId: 'openai', tokenInPath: false })
    expect(env['OPENAI_BASE_URL']).toBe('http://172.17.0.1:8789/u/openai')
  })

  it('extraEnv 里的 ${} 引用被展开', () => {
    // claude 定义里那条 ANTHROPIC_CUSTOM_HEADERS 就是靠这个把舱令牌塞进请求头，
    // 从而避免令牌出现在 URL 里。
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: false })
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Abx-Cell: tok-abc\nX-Abx-Cell-Id: cell-1')
  })

  it('codex 走的是另一组变量名', () => {
    const codex = findAgent('codex')
    if (codex === null) throw new Error('注册表里应当有 codex')
    const env = buildCellEnv({ ...base, agent: codex, upstreamId: 'openai', tokenInPath: false })
    expect(env['OPENAI_BASE_URL']).toBe('http://172.17.0.1:8789/u/openai')
    expect(env['OPENAI_API_KEY']).toBe('abx-placeholder-openai')
  })

  it('dsh 是占位定义，注入的变量名按通用约定', () => {
    const dsh = findAgent('dsh')
    if (dsh === null) throw new Error('注册表里应当有 dsh')
    expect(dsh.status).toBe('unconfirmed')
    const env = buildCellEnv({ ...base, agent: dsh, upstreamId: 'dsh', tokenInPath: false })
    expect(env['DSH_BASE_URL']).toBe('http://172.17.0.1:8789/u/dsh')
    expect(env['DSH_API_KEY']).toBe('abx-placeholder-dsh')
  })

  it('注入的值里不含任何宿主环境里的东西', () => {
    // buildCellEnv 是纯函数：它的输入只有这几个参数，
    // 所以「宿主环境会不会漏进去」这件事在类型上就不可能发生。
    const env = buildCellEnv({ ...base, agent: claude, tokenInPath: false })
    expect(Object.keys(env).sort()).toEqual([
      'ABX_BROKER_ORIGIN',
      'ABX_CELL_ID',
      'ABX_CELL_TOKEN',
      'ABX_UPSTREAM_ID',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
    ])
  })
})

describe('generateCellId', () => {
  it('带上 agent 名和时间戳', () => {
    const id = generateCellId('claude', new Date('2026-10-23T10:20:30.000Z'))
    expect(id.startsWith('claude-20261023102030-')).toBe(true)
  })

  it('同一时刻两次调用也不撞名', () => {
    const now = new Date('2026-10-23T10:20:30.000Z')
    expect(generateCellId('claude', now)).not.toBe(generateCellId('claude', now))
  })

  it('产生的字符集能直接用做容器名', () => {
    // docker 容器名只允许 [a-zA-Z0-9][a-zA-Z0-9_.-]*。
    expect(generateCellId('claude')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  })
})
