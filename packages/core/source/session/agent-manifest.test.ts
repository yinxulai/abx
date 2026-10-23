/**
 * 「加一个 agent = 加一条清单」的判据。
 *
 * 这个文件里有一个**只在测试里存在**的 agent：它不进注册表，也不碰渲染器、
 * 挂载策略、docker 后端里的任何一行代码。如果清单真是唯一真相，那么把它的四个
 * 字段写出来之后，下面四件事就都该按它产出：
 *
 *   1. 配置内容（模板 + 变量）
 *   2. 舱内主目录与宿主侧状态目录（`statePaths`）
 *   3. 挂载清单，且过得了挂载策略那几道闸
 *   4. 起舱参数（`image` + `command` / `args`）
 *
 * 这四条合起来才是那句话的判据：少任何一条，「加一条数据」就还是句空话。
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentManifestProblems, type AgentDefinition } from '@abx/contracts'
import { RUNNING_PLATFORM, RUNNING_VOCABULARY } from '../test-support'
import type { SandboxSpec, SandboxStateDir } from './backend'
import { buildDockerArgs } from './docker-backend'
import { ensureInstanceStateDir, planInstance } from './instance'
import { MOUNT_POLICY, assertMountPolicy, assertStateDirPolicy } from './mount-policy'
import { renderAgentConfig, stageAgentConfig, toSandboxConfigFiles } from './agent-config'

/** 舱内路径：永远是容器里的形状，跟宿主无关。 */
const CELL_HOME = '/home/node'
const WORKDIR = '/workspace'
/** 宿主那边只有任务目录一个。按跑测试这台机器造。 */
const TASK_DIR = RUNNING_VOCABULARY.taskDir
const CELL_ORIGIN = 'http://host.docker.internal:8789'

/**
 * 一条假清单。
 *
 * 配置文件名用的是 `settings.json`——挂载策略最后那道形状检查认的是**注册表里
 * 登记过的文件名**（`agentConfigFileNames()`，一张全局名单）。这条假清单不进注册表，
 * 所以借一个已登记的名字；「换一个新名字」那条规则由 `agents.test.ts` 与
 * `mount-policy.test.ts` 各自守着，不在这里重复。
 */
const FAKE_AGENT: AgentDefinition = {
  id: 'fakey',
  label: 'Fakey CLI',
  icon: { slug: 'fakey', color: '#336699' },
  statePaths: [{ path: '~/.fakey', mode: 'rw' }],
  image: { repository: 'abx-agent-fakey', version: '9.9.9' },
  command: 'fakey',
  args: ['--headless'],
  upstreamId: 'fake-upstream',
  baseUrlEnv: 'FAKEY_BASE_URL',
  tokenEnv: 'FAKEY_API_KEY',
  placeholderToken: 'abx-placeholder-fakey',
  extraEnv: { FAKEY_HEADERS: 'X-Abx-Cell: ${ABX_CELL_TOKEN}' },
  cellTokenVia: 'header',
  oswClientKey: 'fakey',
  configFiles: [
    {
      path: '~/.fakey/settings.json',
      format: 'json',
      generated: true,
      template: [
        '{',
        '  "env": {',
        '    "${baseUrlEnv}": "${baseUrl}",',
        '    "${tokenEnv}": "${placeholderToken}"',
        '  }',
        '}',
        '',
      ].join('\n'),
      note: '假 agent 的配置，形状与 claude 那份一样，但内容来自它自己的模板。',
    },
  ],
  status: 'unconfirmed',
  note: '只在测试里存在的一条清单。',
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

/** 按清单把这次会话的目录与挂载算出来，顺序照抄 `commands/open.ts`。 */
function plan(
  cellToken = 'abx-cell-token-fakey',
): { readonly stateDir: SandboxStateDir; readonly instancesRoot: string; readonly spec: SandboxSpec } {
  // realpath：后面 `stateDir.hostPath` 是 `ensureInstanceStateDir` 解析过软链的结果，
  // 两边不先归一就比不到一起（Windows 的 `%TEMP%` 可能是 8.3 短名）。
  const instancesRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-agent-manifest-')))
  roots.push(instancesRoot)

  const instance = planInstance({ agent: FAKE_AGENT, instanceId: FAKE_AGENT.id, cellHome: CELL_HOME, instancesRoot })
  const stateDir: SandboxStateDir = {
    hostPath: ensureInstanceStateDir(instance),
    cellPath: instance.cellPath,
    agentId: FAKE_AGENT.id,
  }
  assertStateDirPolicy({ platform: RUNNING_PLATFORM, stateDirs: [stateDir], instancesRoot, cellHome: CELL_HOME })

  const staged = stageAgentConfig({
    agentId: FAKE_AGENT.id,
    definition: FAKE_AGENT,
    directory: stateDir.hostPath,
    cellOrigin: CELL_ORIGIN,
    upstreamId: FAKE_AGENT.upstreamId,
    cellToken,
    cellHome: CELL_HOME,
  })

  return {
    stateDir,
    instancesRoot,
    spec: {
      cellId: 'fakey-20261023-ab12cd',
      platform: RUNNING_PLATFORM,
      agentId: FAKE_AGENT.id,
      command: [FAKE_AGENT.command, ...FAKE_AGENT.args],
      allocateTty: false,
      taskDir: TASK_DIR,
      workdir: WORKDIR,
      cellHome: CELL_HOME,
      agentConfigFiles: toSandboxConfigFiles(staged),
      stateDirs: [stateDir],
      env: { FAKEY_BASE_URL: `${CELL_ORIGIN}/u/${FAKE_AGENT.upstreamId}`, FAKEY_API_KEY: FAKE_AGENT.placeholderToken },
      forbiddenEnvNames: [],
      limits: { memory: '2g', pids: 256, cpus: 2 },
      image: `${FAKE_AGENT.image.repository}:${FAKE_AGENT.image.version}`,
      user: '1000:1000',
      network: 'bridge',
      tmpfsSizeMb: 64,
    },
  }
}

describe('假 agent：只加一条清单就能跑通整条路', () => {
  it('清单自检认它（四个字段都写全了）', () => {
    expect(agentManifestProblems([FAKE_AGENT])).toEqual([])
  })

  it('配置内容按清单里的模板产出', () => {
    const rendered = renderAgentConfig({
      agentId: FAKE_AGENT.id,
      definition: FAKE_AGENT,
      cellOrigin: CELL_ORIGIN,
      cellToken: 'abx-cell-token-fakey',
      cellHome: CELL_HOME,
    })

    expect(rendered.files).toHaveLength(1)
    expect(rendered.files[0]?.cellPath).toBe(`${CELL_HOME}/.fakey/settings.json`)
    // 端点与占位符两个变量都进了模板，而且端点指向气闸舱面（令牌走请求头，所以不在 URL 里）。
    expect(JSON.parse(rendered.files[0]?.content ?? '')).toEqual({
      env: { FAKEY_BASE_URL: `${CELL_ORIGIN}/u/fake-upstream`, FAKEY_API_KEY: 'abx-placeholder-fakey' },
    })
  })

  it('舱内主目录来自 statePaths，宿主侧那一格仍然按 <实例根>/<实例 id>/<agentId> 造', () => {
    const { stateDir, instancesRoot } = plan()
    expect(stateDir.cellPath).toBe(`${CELL_HOME}/.fakey`)
    expect(stateDir.hostPath).toBe(path.join(instancesRoot, FAKE_AGENT.id, FAKE_AGENT.id))
  })

  it('挂载清单按 statePaths + configFiles 产出，并且过得了挂载策略', () => {
    const { spec, instancesRoot } = plan()

    const mounts = MOUNT_POLICY.buildMounts(spec.taskDir, spec.workdir, spec.agentConfigFiles, spec.stateDirs)
    const configFile = spec.agentConfigFiles?.[0]
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: spec.stateDirs?.[0]?.hostPath, target: `${CELL_HOME}/.fakey`, mode: 'rw' },
      { source: configFile?.hostPath, target: `${CELL_HOME}/.fakey/settings.json`, mode: 'ro' },
    ])

    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts,
        taskDir: spec.taskDir,
        workdir: spec.workdir,
        agentConfigFiles: spec.agentConfigFiles,
        stateDirs: spec.stateDirs,
        instancesRoot,
        cellHome: CELL_HOME,
      }),
    ).not.toThrow()
  })

  it('起舱参数按 image / command / args 产出，用的就是它自己的镜像', () => {
    const { spec } = plan()
    const mounts = MOUNT_POLICY.buildMounts(spec.taskDir, spec.workdir, spec.agentConfigFiles, spec.stateDirs)
    const args = buildDockerArgs(spec, mounts)

    const imageIndex = args.indexOf('abx-agent-fakey:9.9.9')
    expect(imageIndex).toBeGreaterThan(-1)
    // 镜像之后紧跟的就是它自己的命令与参数（`docker run <image> <command…>`）。
    expect(args.slice(imageIndex)).toEqual(['abx-agent-fakey:9.9.9', 'fakey', '--headless'])
  })
})
