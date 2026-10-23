/**
 * agent 注册表的一致性用例。
 *
 * 这张表是「舱内到底该读哪几个文件」的唯一来源，而它最容易出的错不是写错一个字段，
 * 而是**漏**——漏登一个配置文件，或者把同目录里的凭据文件也当成配置登记进来。
 * 后者尤其致命：挂载策略拿不出「哪些文件是配置」这份名单，就只能靠路径前缀猜，
 * 而凭据文件恰恰就在配置文件的隔壁。
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  AgentManifestError,
  agentConfigFileNames,
  agentHomeDirNames,
  agentIds,
  agentImageRef,
  agentManifestProblems,
  findAgent,
  generatedConfigFiles,
  renderAgentConfigTemplate,
  type AgentDefinition,
} from './agents'
import { MCP_SHIM_CELL_PATH } from './transom'

const CREDENTIAL_NAMES = ['.credentials.json', 'auth.json', 'id_rsa', 'credentials']

describe('AGENT_DEFINITIONS 的配置面', () => {
  it('每个 agent 都对得上一个 OSW client key', () => {
    for (const agent of AGENT_DEFINITIONS) {
      expect(agent.oswClientKey.length).toBeGreaterThan(0)
    }
    // 两个名字必须指同一样东西，写下映射关系本身就是为了以后能对账。
    expect(findAgent('claude')?.oswClientKey).toBe('claude-code')
    expect(findAgent('codex')?.oswClientKey).toBe('codex')
    expect(findAgent('dsh')?.oswClientKey).toBe('deepseek-harness')
  })

  it('oswClientKey 不重复——两个 agent 指同一个 client 一定是写错了', () => {
    const keys = AGENT_DEFINITIONS.map((agent) => agent.oswClientKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('每个 agent 至少有一个 abx 要生成的配置文件', () => {
    for (const agent of AGENT_DEFINITIONS) {
      expect(generatedConfigFiles(agent).length).toBeGreaterThan(0)
    }
  })

  it('登记的全是文件，没有一个是目录', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of agent.configFiles) {
        const name = file.path.split('/').at(-1) ?? ''
        // 有扩展名 = 是文件。`~/.claude` 这种目录没有任何扩展名，会在这一步露馅。
        expect(name).toMatch(/\.(json|toml|yaml|yml)$/)
        expect(file.path).not.toBe('~')
      }
    }
  })

  it('凭据文件一个都不许登记成配置', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of agent.configFiles) {
        const name = file.path.split('/').at(-1) ?? ''
        expect(CREDENTIAL_NAMES).not.toContain(name)
      }
    }
  })

  it('三个 agent 的配置文件与 OSW 注册表一致', () => {
    expect(findAgent('claude')?.configFiles.map((file) => [file.path, file.format])).toEqual([
      ['~/.claude/settings.json', 'json'],
      ['~/.claude.json', 'json'],
    ])
    expect(findAgent('codex')?.configFiles.map((file) => [file.path, file.format])).toEqual([
      ['~/.codex/config.toml', 'toml'],
    ])
  })

  it('dsh 登记了遗留的 config.yaml，但只生成 settings.yaml', () => {
    const dsh = findAgent('dsh')
    expect(dsh?.configFiles.map((file) => file.path)).toEqual(['~/.dsh/settings.yaml', '~/.dsh/config.yaml'])
    expect(generatedConfigFiles(dsh!).map((file) => file.path)).toEqual(['~/.dsh/settings.yaml'])
  })

  it('agentConfigFileNames 给出的是不含目录的文件名', () => {
    expect([...agentConfigFileNames()].sort()).toEqual([
      '.claude.json',
      'config.toml',
      'config.yaml',
      'settings.json',
      'settings.yaml',
    ])
  })

  it('claude / codex 有权威来源，dsh 还没有', () => {
    expect(findAgent('claude')?.status).toBe('stable')
    expect(findAgent('codex')?.status).toBe('stable')

    const dsh = findAgent('dsh')
    expect(dsh?.status).toBe('unconfirmed')
    // 「待确认」必须说清还差哪一步，否则下一个人只能猜。
    expect(dsh?.note).toContain('settings.yaml')
  })

  it('agentIds 与注册表同步', () => {
    expect(agentIds()).toEqual(AGENT_DEFINITIONS.map((agent) => agent.id))
  })
})

/** 拿一条真清单改几个字段，用来验证自检**真的会**拦下写错的清单。 */
function patched(overrides: Partial<AgentDefinition>): AgentDefinition {
  const claude = findAgent('claude')
  if (claude === null) throw new Error('注册表里没有 claude')
  return { ...claude, ...overrides }
}

describe('清单的四组数据：展示 / 持久化目录 / 镜像 / 配置内容', () => {
  it('注册表自己是自洽的（lint 与测试跑的是同一份判据）', () => {
    expect(agentManifestProblems()).toEqual([])
  })

  it('每个 agent 都自带镜像，版本钉住，不许是 latest', () => {
    for (const agent of AGENT_DEFINITIONS) {
      expect(agent.image.repository.trim()).not.toBe('')
      expect(agent.image.version.trim()).not.toBe('')
      expect(agent.image.version).not.toBe('latest')
      expect(agentImageRef(agent)).toBe(`${agent.image.repository}:${agent.image.version}`)
    }
    // 有镜像的那两条要能对上真实存在的标签（`images/agents/<id>/` 下有各自的
    // Dockerfile，构建脚本打的就是这个标签）。
    expect(agentImageRef(findAgent('claude')!)).toBe('abx-agent-claude:2.1.308')
    expect(agentImageRef(findAgent('codex')!)).toBe('abx-agent-codex:0.164.0')
  })

  it('镜像按 agent 给，没有两个 agent 共用一个仓库', () => {
    const repositories = AGENT_DEFINITIONS.map((agent) => agent.image.repository)
    expect(new Set(repositories).size).toBe(repositories.length)
  })

  it('还没建镜像的 agent 写 unbuilt，而不是编一个版本号', () => {
    // claude 与 codex 的镜像都存在（images/agents/<id>/），dsh 还没有。剩下这条写
    // unbuilt 是**如实**：编一个版本号会让人以为镜像已经在了。
    expect(AGENT_IMAGE_UNBUILT).toBe('unbuilt')
    const unbuilt = AGENT_DEFINITIONS.filter((agent) => agent.image.version === AGENT_IMAGE_UNBUILT)
    expect(unbuilt.map((agent) => agent.id)).toEqual(['dsh'])
  })

  it('每个 agent 都登记了持久化目录，写法是 ~/...', () => {
    for (const agent of AGENT_DEFINITIONS) {
      expect(agent.statePaths.length).toBeGreaterThan(0)
      for (const statePath of agent.statePaths) {
        expect(statePath.path).toMatch(/^~\/[^/]/)
        expect(statePath.mode).toBe('rw')
      }
    }
    // 三条各自的主目录，与 OSW 注册表里那几个目录对得上。
    expect(AGENT_DEFINITIONS.map((agent) => agent.statePaths.map((statePath) => statePath.path))).toEqual([
      ['~/.claude'],
      ['~/.codex'],
      ['~/.dsh'],
    ])
  })

  it('agentHomeDirNames 从 statePaths 现算，不另抄一份', () => {
    expect([...agentHomeDirNames()].sort()).toEqual(['.claude', '.codex', '.dsh'])
  })

  it('会生成的配置都带模板，不生成的一个都不带', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of agent.configFiles) {
        if (file.generated) expect(file.template).toBeTruthy()
        else expect(file.template).toBeUndefined()
      }
    }
    // 不生成的那一份（dsh 的遗留 config.yaml）只登记路径。
    const dsh = findAgent('dsh')!
    expect(dsh.configFiles.find((file) => !file.generated)?.path).toBe('~/.dsh/config.yaml')
  })

  it('每条生成的配置要么落在持久化目录里，要么是一条写明了的例外', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of generatedConfigFiles(agent)) {
        const directory = file.path.split('/').slice(0, -1).join('/')
        const inside = agent.statePaths.some((statePath) => statePath.path === directory)
        // 例外只有一种形状：舱内 home 根上的那一个文件，而且必须自己标出来。
        expect(inside || (file.outsideStatePaths === true && directory === '~')).toBe(true)
      }
    }
  })

  it('目前唯一一条例外是 claude 的 ~/.claude.json（MCP 只能注册在用户级那份里）', () => {
    const outside = AGENT_DEFINITIONS.flatMap((agent) =>
      generatedConfigFiles(agent)
        .filter((file) => file.outsideStatePaths === true)
        .map((file) => `${agent.id}:${file.path}`),
    )
    expect(outside).toEqual(['claude:~/.claude.json'])
  })

  it('stable 的 agent 都把传递窗注册上了，而且路径来自变量', () => {
    for (const agent of AGENT_DEFINITIONS.filter((candidate) => candidate.status === 'stable')) {
      const templates = generatedConfigFiles(agent).map((file) => file.template ?? '')
      expect(templates.some((template) => template.includes('${mcpShimPath}')), `${agent.id} 没登记传递窗`).toBe(true)
      // 路径只能从变量来：抄一份字面量进模板，挂载策略那边改了就没人跟着改。
      expect(templates.join('\n')).not.toContain(MCP_SHIM_CELL_PATH)
    }
  })

  it('传递窗的注册里没有任何凭据——回连地址与令牌都从舱内环境变量读', () => {
    // 「配置里只有占位符」这条承诺，对新加的这份配置同样成立。
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of agent.configFiles) {
        if (!(file.template ?? '').includes('${mcpShimPath}')) continue
        expect(file.template).not.toMatch(/abx_cell_|Bearer |api[_-]?key|token"\s*:/i)
      }
    }
  })

  it('icon 是可选的：不写的 agent 什么都不用加', () => {
    // claude 有标识与颜色，codex 只有标识，dsh 整个没有——三种形态都是合法的。
    expect(findAgent('claude')?.icon).toEqual({ slug: 'claude', color: '#d97757' })
    expect(findAgent('codex')?.icon).toEqual({ slug: 'codex' })
    expect(findAgent('dsh')?.icon).toBeUndefined()
  })
})

describe('清单自检拦得下写错的清单', () => {
  const problems = (overrides: Partial<AgentDefinition>): readonly string[] => agentManifestProblems([patched(overrides)])

  it('版本是 latest、是空的、镜像仓库是空的，各报一条', () => {
    expect(problems({ image: { repository: 'x', version: 'latest' } }).join()).toContain('latest')
    expect(problems({ image: { repository: 'x', version: ' ' } }).join()).toContain('AGENT_IMAGE_UNBUILT')
    expect(problems({ image: { repository: '', version: '1.0.0' } }).join()).toContain('image.repository')
  })

  it('持久化目录写成绝对路径 → 报错（模板与挂载都按 ~/... 展开）', () => {
    expect(problems({ statePaths: [{ path: '/home/node/.claude', mode: 'rw' }] }).join()).toContain('~/...')
    expect(problems({ statePaths: [] }).join()).toContain('statePaths 是空的')
  })

  it('一条清单登记多个持久化目录 → 报错，而不是静默只挂第一个', () => {
    const both = [
      { path: '~/.claude', mode: 'rw' as const },
      { path: '~/.claude-state', mode: 'rw' as const },
    ]
    expect(problems({ statePaths: both }).join()).toContain('只挂一个')
  })

  it('生成的配置没有模板、不生成的却带模板，各报一条', () => {
    const claude = findAgent('claude')!
    const file = claude.configFiles[0]!
    expect(problems({ configFiles: [{ ...file, template: undefined }] }).join()).toContain('没有 template')
    expect(problems({ configFiles: [{ ...file, generated: false }] }).join()).toContain('只会误导下一个人')
  })

  it('模板里出现白名单之外的变量 → 报错，而不是渲染出一个空值', () => {
    const claude = findAgent('claude')!
    const file = claude.configFiles[0]!
    const template = '{"key": "${secretEnv}"}'
    expect(problems({ configFiles: [{ ...file, template }] }).join()).toContain('secretEnv')
  })

  it('配置不在持久化目录里 → 报错（挂在舱里的目录之外没人会读它）', () => {
    const claude = findAgent('claude')!
    const file = claude.configFiles[0]!
    expect(problems({ configFiles: [{ ...file, path: '~/.elsewhere/settings.json' }] }).join()).toContain('不在任何 statePaths')
  })

  it('stable 的 agent 漏掉传递窗 → 报错', () => {
    // 漏掉它不会让任何东西起不来，只会让舱内的 agent 永远递不出东西——
    // 那是最难发现的一类问题，所以要在清单自检这一层拦住。
    const claude = findAgent('claude')!
    const withoutMcp = claude.configFiles
      .filter((file) => !(file.template ?? '').includes('${mcpShimPath}'))
      .map((file) => ({ ...file, outsideStatePaths: undefined }))
    expect(problems({ configFiles: withoutMcp }).join()).toContain('没有登记传递窗')
  })

  it('给 dsh 那种还没核实的 agent 不要求传递窗——编一个字段名比不写更坏', () => {
    const dsh = findAgent('dsh')!
    const problemsForDsh = agentManifestProblems([dsh])
    expect(problemsForDsh.join()).not.toContain('没有登记传递窗')
  })

  it('outsideStatePaths 只能用在那一种形状上：舱内 home 根、而且是生成的', () => {
    const claude = findAgent('claude')!
    const file = claude.configFiles[1]!

    // 标了，却不在 home 根上 → 它就是在绕开「配置必须落在持久化目录里」这条规则。
    expect(problems({ configFiles: [{ ...file, path: '~/.elsewhere/config.json' }] }).join()).toContain(
      '不在舱内 home 的根上',
    )
    // 标了，却不生成 → 既不落盘也不挂载，这个标记没有意义。
    expect(problems({ configFiles: [{ ...file, generated: false, template: undefined }] }).join()).toContain(
      '却不是 generated',
    )
    // 本来就在持久化目录里，还标它 → 标错了。
    expect(problems({ configFiles: [{ ...file, path: '~/.claude/x.json' }] }).join()).toContain('标错了')
  })

  it('没写 outsideStatePaths 的配置落在持久化目录之外，照样报错', () => {
    const claude = findAgent('claude')!
    const file = claude.configFiles[1]!
    expect(problems({ configFiles: [{ ...file, outsideStatePaths: undefined }] }).join()).toContain(
      '不在任何 statePaths',
    )
  })

  it('id 重复、id 写成大写 → 报错', () => {
    const claude = findAgent('claude')!
    expect(agentManifestProblems([claude, claude]).join()).toContain('id 重复')
    expect(problems({ id: 'Claude' }).join()).toContain('小写字母开头')
  })

  it('icon 给了但是 slug 是空的 → 报错', () => {
    expect(problems({ icon: { slug: ' ' } }).join()).toContain('icon.slug')
  })
})

describe('模板渲染', () => {
  const values = { baseUrl: 'http://cell:8789/u/anthropic', tokenEnv: 'ANTHROPIC_AUTH_TOKEN' }

  it('把白名单里的变量换进去', () => {
    expect(renderAgentConfigTemplate('"${tokenEnv}": "${baseUrl}"', values, 'json')).toBe(
      '"ANTHROPIC_AUTH_TOKEN": "http://cell:8789/u/anthropic"',
    )
  })

  it('白名单之外的变量直接抛，不渲染成空串', () => {
    expect(() => renderAgentConfigTemplate('"${nope}"', values, 'json')).toThrow(AgentManifestError)
    expect(() => renderAgentConfigTemplate('"${nope}"', values, 'json')).toThrow(/未知变量 \$\{nope\}/)
  })

  it('值先转义再放进去：引号撑不破 JSON / TOML / YAML 的结构', () => {
    for (const format of ['json', 'toml', 'yaml'] as const) {
      const rendered = renderAgentConfigTemplate('{"base_url": "${baseUrl}"}', { baseUrl: 'a"b\\c\nd' }, format)
      expect(JSON.parse(rendered)).toEqual({ base_url: 'a"b\\c\nd' })
    }
  })

  it('三种格式的转义是同一条规则（JSON 转义是 TOML / YAML 字符串的子集）', () => {
    const template = '"${baseUrl}"'
    const escapeProbe = { baseUrl: 'x"y' }
    const rendered = (['json', 'toml', 'yaml'] as const).map((format) =>
      renderAgentConfigTemplate(template, escapeProbe, format),
    )
    expect(new Set(rendered).size).toBe(1)
    expect(rendered[0]).toBe('"x\\"y"')
  })
})
