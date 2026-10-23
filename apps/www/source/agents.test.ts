import {
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  type AgentDefinition,
} from '@abx/contracts/agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROWS, buildAgentRows, TRAY_AGENT_ROWS, trayAgentRows } from './agents'

/**
 * 这一节的风险只有一个：**官网自己抄了一份 agent 数据，然后跟清单漂移**。
 * 所以这里逐条锁住「页面上每个值都来自清单」：改清单必须能改到页面，
 * 清单里没有的东西不许凭空出现。
 *
 * 类型也一律用清单的（`AgentDefinition` / `AgentImage` / `AgentStatePath`）：
 * 上一版在这里另写了一份 `{ repository, tag }` 的推测形状，清单补上 `version`
 * 之后它就悄悄过期了。让 TypeScript 拿真契约检查，比再手写一份更可靠。
 */

const definitionOf = (patch: Partial<AgentDefinition>): AgentDefinition => {
  const base = AGENT_DEFINITIONS[0]
  if (base === undefined) throw new Error('清单是空的：测试的前提不成立')
  return { ...base, ...patch }
}

describe('agent rows', () => {
  it('renders one row per manifest entry, in manifest order', () => {
    expect(AGENT_ROWS.map(row => row.id)).toEqual(AGENT_DEFINITIONS.map(agent => agent.id))
    expect(AGENT_ROWS).toHaveLength(3)
  })

  it('takes every displayed value from the manifest', () => {
    for (const [index, definition] of AGENT_DEFINITIONS.entries()) {
      const row = AGENT_ROWS[index]
      if (row === undefined) throw new Error(`第 ${index} 个 agent 没有对应的行`)

      expect(row.label).toBe(definition.label)
      expect(row.command).toBe([definition.command, ...definition.args].join(' '))
      expect(row.upstreamId).toBe(definition.upstreamId)
      expect(row.status).toBe(definition.status)
      expect(row.baseUrlEnv).toBe(definition.baseUrlEnv)
      expect(row.tokenEnv).toBe(definition.tokenEnv)
      expect(row.placeholderToken).toBe(definition.placeholderToken)
      expect(row.cellTokenVia).toBe(definition.cellTokenVia)
      expect(row.configFiles).toEqual(definition.configFiles)
      expect(row.statePaths).toEqual(definition.statePaths.map(statePath => statePath.path))
    }
  })

  it('reads each agent state directory from its manifest entry', () => {
    const directories = Object.fromEntries(AGENT_ROWS.map(row => [row.id, row.statePaths]))

    expect(directories).toEqual({
      claude: ['~/.claude'],
      codex: ['~/.codex'],
      dsh: ['~/.dsh'],
    })
  })

  it('passes declared statePaths through in the order the manifest gives them', () => {
    const rows = buildAgentRows([
      definitionOf({
        id: 'fake',
        statePaths: [
          { path: '~/.fake/state', mode: 'rw' },
          { path: '~/.fake/cache', mode: 'rw' },
        ],
      }),
    ])

    expect(rows[0]?.statePaths).toEqual(['~/.fake/state', '~/.fake/cache'])
  })

  it('turns the unbuilt sentinel into a state, not a version', () => {
    // `unbuilt` 是给脚本看的哨兵值。数据层必须把它翻成状态，
    // 否则页面会显示 `abx-agent-dsh:unbuilt`，读起来像一个真实版本号。
    const byId = Object.fromEntries(AGENT_ROWS.map(row => [row.id, row.image]))

    expect(byId.claude).toEqual({ state: 'built', repository: 'abx-agent-claude', version: '2.1.308' })
    expect(byId.codex).toEqual({ state: 'built', repository: 'abx-agent-codex', version: '0.164.0' })
    expect(byId.dsh).toEqual({ state: 'unbuilt', repository: 'abx-agent-dsh' })

    // 未构建的那一行**没有 version 字段**：页面因此拼不出 `仓库:unbuilt`。
    expect(byId.dsh).not.toHaveProperty('version')

    // 构建了的那一行，version 也不许是哨兵值。
    for (const row of AGENT_ROWS) {
      if (row.image.state === 'built') {
        expect(row.image.version).not.toBe(AGENT_IMAGE_UNBUILT)
      }
    }
  })

  it('keeps the repository when the image is not built yet', () => {
    const rows = buildAgentRows([
      definitionOf({
        id: 'fake',
        image: { repository: 'abx-agent-fake', version: AGENT_IMAGE_UNBUILT },
      }),
    ])

    expect(rows[0]?.image).toEqual({ state: 'unbuilt', repository: 'abx-agent-fake' })
  })

  it('passes a built image through as repository and version', () => {
    const rows = buildAgentRows([
      definitionOf({
        id: 'fake',
        image: { repository: 'ghcr.io/example/abx-agent-fake', version: '1.2.3' },
      }),
    ])

    expect(rows[0]?.image).toEqual({
      state: 'built',
      repository: 'ghcr.io/example/abx-agent-fake',
      version: '1.2.3',
    })
  })

  it('survives a definition without any config file', () => {
    // 历史目录现在直接来自 statePaths，不再从配置文件的父目录推导：
    // 所以「没有配置文件」只是「这一格没有文件」，行照常产出。
    const base = AGENT_DEFINITIONS[0]
    if (base === undefined) throw new Error('清单是空的：测试的前提不成立')

    const rows = buildAgentRows([definitionOf({ id: 'fake', configFiles: [] })])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.configFiles).toEqual([])
    expect(rows[0]?.statePaths).toEqual(base.statePaths.map(statePath => statePath.path))
  })
})

/**
 * 首屏那张托盘面板示意图里的一排。它比「Agent 一览」少一层：
 * 托盘**只放已安装的 agent**（`tray-ui.md` §3.1 ④），镜像还没构建的进去就是画了个
 * 认不出来的身份。所以这里锁两件事：dsh 今天不在里面，以及「不在里面」是**算出来的**
 * ——判据是清单的镜像状态，不是这份文件里手写的名单。
 */
describe('tray agent row', () => {
  it('leaves the agents whose image is not built out of the tray', () => {
    expect(TRAY_AGENT_ROWS.map(row => row.id)).toEqual(['claude', 'codex'])
    expect(TRAY_AGENT_ROWS.map(row => row.id)).not.toContain('dsh')
  })

  it('filters on the manifest image state, not on a hand-written name list', () => {
    const rows = trayAgentRows([
      definitionOf({
        id: 'unbuilt',
        image: { repository: 'abx-agent-unbuilt', version: AGENT_IMAGE_UNBUILT },
      }),
      definitionOf({ id: 'built', image: { repository: 'abx-agent-built', version: '1.0.0' } }),
    ])

    expect(rows.map(row => row.id)).toEqual(['built'])
  })

  it('is the full row list minus the unbuilt ones, in manifest order', () => {
    const unbuilt = AGENT_ROWS.filter(row => row.image.state === 'unbuilt').map(row => row.id)

    expect(unbuilt).toEqual(['dsh'])
    expect(TRAY_AGENT_ROWS).toEqual(AGENT_ROWS.filter(row => row.image.state === 'built'))
  })
})
