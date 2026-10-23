/**
 * 生成配置的用例。
 *
 * 这里钉死的是三件**不能靠跑一次容器发现**的事：
 *   1. 端点等于传进来的那个舱面地址——写错一个字符，agent 就去连别的地方了；
 *   2. 配置里没有 `model`——写死模型等于把模型选择从 OSW 手里拿走；
 *   3. 舱内那份路径与宿主一致（D2）——路径不一致等于没配，agent 根本不会去那儿找。
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CELL_HOME, findAgent, generatedConfigFiles, AGENT_DEFINITIONS } from '@abx/contracts'
import { AgentConfigError, cellRootFor, renderAgentConfig, stageAgentConfig, toSandboxConfigFiles } from './agent-config'
import { buildCellEnv } from './env'
import { MOUNT_POLICY, assertMountPolicy } from './mount-policy'

const CELL_ORIGIN = 'http://host.docker.internal:8789'
const HOME = '/home/dev'

function render(agentId: string, overrides: Record<string, unknown> = {}) {
  return renderAgentConfig({ agentId, cellOrigin: CELL_ORIGIN, cellHome: HOME, ...overrides })
}

function contentOf(agentId: string, overrides: Record<string, unknown> = {}): string {
  const [file] = render(agentId, overrides).files
  if (file === undefined) throw new Error(`${agentId} 没有生成任何文件`)
  return file.content
}

describe('renderAgentConfig / claude（JSON）', () => {
  it('配置里的 baseUrl 就是传进来的舱面地址', () => {
    const parsed = JSON.parse(contentOf('claude')) as { env: Record<string, string> }
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(`${CELL_ORIGIN}/u/anthropic`)
  })

  it('环境变量与配置文件用的是同一个 baseUrl', () => {
    // 两处各拼一次的话，路由形态一改就会改漏一处，然后舱内一半说 A 一半说 B。
    const agent = findAgent('claude')!
    const env = buildCellEnv({
      agent,
      brokerCellOrigin: CELL_ORIGIN,
      cellId: 'claude-1',
      cellToken: 'abx_cell_token',
      upstreamId: 'osw',
      tokenInPath: true,
    })
    const parsed = JSON.parse(contentOf('claude', { upstreamId: 'osw', cellToken: 'abx_cell_token', tokenInPath: true })) as {
      env: Record<string, string>
    }
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(env.ANTHROPIC_BASE_URL)
  })

  it('token 是占位符，不是任何真凭据', () => {
    const parsed = JSON.parse(contentOf('claude')) as { env: Record<string, string> }
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(findAgent('claude')?.placeholderToken)
  })

  it('没有 model 字段——换模型是 OSW 的事', () => {
    const parsed = JSON.parse(contentOf('claude')) as Record<string, unknown> & { env: Record<string, unknown> }
    expect('model' in parsed).toBe(false)
    expect(Object.keys(parsed.env)).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'])
    expect(contentOf('claude')).not.toContain('model')
  })

  it('claude 有请求头可以带令牌，所以令牌不进 URL', () => {
    const content = contentOf('claude', { cellToken: 'abx_cell_token', tokenInPath: true })
    expect(content).not.toContain('abx_cell_token')
  })
})

describe('renderAgentConfig / codex（TOML）', () => {
  it('端点写进 provider 表项', () => {
    const content = contentOf('codex')
    expect(content).toContain('[model_providers.abx]')
    expect(content).toContain(`base_url = "${CELL_ORIGIN}/u/openai"`)
    expect(content).toContain('wire_api = "responses"')
    expect(content).toContain('model_provider = "abx"')
  })

  it('不走请求头，所以舱令牌在 URL 里', () => {
    expect(contentOf('codex', { cellToken: 'abx_cell_token', tokenInPath: true })).toContain(
      `${CELL_ORIGIN}/c/abx_cell_token/u/openai`,
    )
  })

  it('没有 model 这一项（model_provider / model_providers 不算）', () => {
    const lines = contentOf('codex').split('\n')
    expect(lines.some((line) => /^\s*model\s*=/.test(line))).toBe(false)
    expect(lines.some((line) => line.includes('model_reasoning_effort'))).toBe(false)
  })

  it('不写 env_key：写了 Codex 会要求那个环境变量必须存在', () => {
    expect(contentOf('codex')).not.toContain('env_key')
  })
})

describe('renderAgentConfig / dsh（YAML）', () => {
  it('端点写进 provider route，并带上 /v1', () => {
    expect(contentOf('dsh')).toContain(`baseURL: "${CELL_ORIGIN}/u/dsh/v1"`)
  })

  it('自己声明这是待确认的形状，别让人以为已经核过', () => {
    expect(contentOf('dsh')).toContain('待确认')
    expect(contentOf('dsh')).toContain('settings.yaml')
  })

  it('没有模型清单', () => {
    expect(contentOf('dsh')).not.toContain('models')
  })

  it('凭证是占位符，走 Authorization 头', () => {
    expect(contentOf('dsh')).toContain(`Authorization: "Bearer ${findAgent('dsh')?.placeholderToken}"`)
  })
})

describe('renderAgentConfig / 注册表对账', () => {
  it('每个 agent 生成的文件名与舱内路径都对得上注册表', () => {
    for (const agent of AGENT_DEFINITIONS) {
      const rendered = render(agent.id)
      expect(rendered.files.map((file) => file.fileName)).toEqual(
        generatedConfigFiles(agent).map((file) => file.path.split('/').at(-1)),
      )
      for (const [index, file] of rendered.files.entries()) {
        const registered = generatedConfigFiles(agent)[index]!
        expect(file.format).toBe(registered.format)
        // 舱内路径 = 注册表里的 `~/...` 展开之后的样子，而且是绝对路径：
        // 挂载参数只认绝对路径，agent 也只去那个固定的位置找配置（D2）。
        expect(file.cellPath).toBe(path.join(HOME, registered.path.slice(2)))
        expect(path.isAbsolute(file.cellPath)).toBe(true)
      }
      expect(rendered.files.length).toBeGreaterThan(0)
    }
  })

  it('dsh 只生成 settings.yaml，不碰遗留的 config.yaml', () => {
    expect(render('dsh').files.map((file) => file.fileName)).toEqual(['settings.yaml'])
  })

  it('不认识的 agent 直接抛，而不是生成一份空的', () => {
    expect(() => render('nope')).toThrow(AgentConfigError)
  })
})

/**
 * 这一组钉的是一个真实发生过的 bug：`homeDir` 默认取 `os.homedir()`，
 * 于是 `open.ts` 忘了传的时候，生成出来的 `cellPath` 落在**宿主** home 下，
 * 而舱内 agent 只会去读 `$HOME/.claude/settings.json`。
 *
 * 上面那些用例全都显式传了 cellHome，所以它们验的是「传对了会怎样」——
 * 这个 bug 正好从它们的缝里漏过去。这里补的是「默认是什么」。
 */
describe('舱内 home 的默认值', () => {
  it('不传 cellHome 时，生成路径落在舱内 home 下，不是宿主 home 下', () => {
    const [file] = renderAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN }).files
    expect(file?.cellPath).toBe(`${DEFAULT_CELL_HOME}/.claude/settings.json`)
    // 反面对着断言：宿主 home 一个字符都不该出现在舱内路径里。
    expect(file?.cellPath.startsWith(`${homedir()}/`)).toBe(false)
  })

  it('每个 agent 生成的路径都落在舱内 home 下', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const file of renderAgentConfig({ agentId: agent.id, cellOrigin: CELL_ORIGIN }).files) {
        expect(file.cellPath.startsWith(`${DEFAULT_CELL_HOME}/`)).toBe(true)
      }
    }
  })

  it('默认值与镜像里 uid 1000 的 home 一致——换镜像时这里会先红', () => {
    expect(DEFAULT_CELL_HOME).toBe('/home/node')
  })
})

describe('stageAgentConfig', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  function cellRoot(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-cell-'))
    directories.push(directory)
    return path.join(directory, 'cells', 'claude-1')
  }

  it('落到 <cellRoot>/agents/<agentId>/<原文件名>', () => {
    const root = cellRoot()
    const staged = stageAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: root })

    expect(staged.files.map((file) => file.hostPath)).toEqual([path.join(root, 'agents', 'claude', 'settings.json')])
    expect(readFileSync(staged.files[0]!.hostPath, 'utf8')).toBe(staged.files[0]!.content)
  })

  it('每个 agent 落在自己的子目录里', () => {
    const root = cellRoot()
    for (const agent of AGENT_DEFINITIONS) {
      stageAgentConfig({ agentId: agent.id, cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: root })
    }
    for (const agent of AGENT_DEFINITIONS) {
      expect(statSync(path.join(root, 'agents', agent.id)).isDirectory()).toBe(true)
    }
  })

  it('舱内路径与宿主上的原路径一致（D2）', () => {
    const staged = stageAgentConfig({ agentId: 'codex', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: cellRoot() })
    expect(staged.files[0]?.cellPath).toBe('/home/dev/.codex/config.toml')
  })

  it('cellRootFor 把生成目录钉在 ~/.abx/cells/<cellId> 下', () => {
    expect(cellRootFor('claude-1', HOME)).toBe('/home/dev/.abx/cells/claude-1')
  })

  it('cellId 里的目录成分被丢掉，免得生成目录跑到 ~/.abx 外面', () => {
    expect(cellRootFor('../../etc', HOME)).toBe('/home/dev/.abx/cells/etc')
  })

  it('toSandboxConfigFiles 只带路径，不带内容', () => {
    const staged = stageAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: cellRoot() })
    expect(toSandboxConfigFiles(staged)).toEqual([
      { hostPath: staged.files[0]?.hostPath, cellPath: '/home/dev/.claude/settings.json' },
    ])
  })

  it('生成出来的东西能直接过挂载策略：只读单文件', () => {
    // 两个模块之间最容易漂的一处：生成器把文件写到 A，策略以为允许的是 B。
    const root = cellRoot()
    const staged = stageAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: root })
    const configFiles = toSandboxConfigFiles(staged)
    const mounts = MOUNT_POLICY.buildMounts('/home/dev/projects/thing', '/workspace', configFiles)
    expect(() =>
      assertMountPolicy({ mounts, taskDir: '/home/dev/projects/thing', workdir: '/workspace', agentConfigFiles: configFiles }),
    ).not.toThrow()
  })

  it('重跑同一个 cellId 不会因为文件只读而写不进去', () => {
    const root = cellRoot()
    expect(() => {
      stageAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: root })
      stageAgentConfig({ agentId: 'claude', cellOrigin: CELL_ORIGIN, cellHome: HOME, cellRoot: root })
    }).not.toThrow()
  })
})
