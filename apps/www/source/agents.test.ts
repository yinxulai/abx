import { AGENT_DEFINITIONS, type AgentDefinition } from '@abx/contracts/agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROWS, buildAgentRows } from './agents'

/**
 * 这一节的风险只有一个：**官网自己抄了一份 agent 数据，然后跟清单漂移**。
 * 所以这里逐条锁住「页面上每个值都来自清单」：改清单必须能改到页面，
 * 清单里没有的东西不许凭空出现。
 */

/** 清单上还没有、正在往里搬的字段（与 `source/agents.ts` 的读法一致）。 */
type PendingFields = {
  image?: { repository: string; tag: string }
  statePaths?: readonly { path: string }[]
}

type DefinitionPatch = Partial<AgentDefinition> & PendingFields

const definitionOf = (patch: DefinitionPatch): AgentDefinition & PendingFields => {
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
    }
  })

  it('derives each agent state directory from its own config files', () => {
    const directories = Object.fromEntries(AGENT_ROWS.map(row => [row.id, row.statePaths]))

    expect(directories).toEqual({
      claude: ['~/.claude'],
      codex: ['~/.codex'],
      dsh: ['~/.dsh'],
    })
  })

  it('lets a declared statePaths win over the derived one', () => {
    const rows = buildAgentRows([
      definitionOf({
        id: 'fake',
        configFiles: [
          { path: '~/.fake/settings.json', format: 'json', generated: true, note: '' },
        ],
        statePaths: [{ path: '~/.fake/state' }, { path: '~/.fake/cache' }],
      }),
    ])

    expect(rows[0]?.statePaths).toEqual(['~/.fake/state', '~/.fake/cache'])
  })

  it('says the image is missing instead of inventing one', () => {
    // 清单当前没有按 agent 声明镜像 —— 页面必须显示「没有」，而不是拿全局镜像顶上。
    expect(AGENT_ROWS.map(row => row.image)).toEqual([null, null, null])
  })

  it('picks up a per-agent image as soon as the manifest declares one', () => {
    const rows = buildAgentRows([
      definitionOf({
        id: 'fake',
        image: { repository: 'ghcr.io/example/abx-agent-fake', tag: '1.2.3' },
      }),
    ])

    expect(rows[0]?.image).toEqual({
      repository: 'ghcr.io/example/abx-agent-fake',
      tag: '1.2.3',
    })
  })

  it('treats a half-written image declaration as missing', () => {
    // 清单写坏一格（少了 tag）时页面显示「未指定」，不是显示半个镜像地址。
    const halfWritten = { image: { repository: 'ghcr.io/example/abx-agent-fake' } }
    const rows = buildAgentRows([
      definitionOf({ id: 'fake', ...halfWritten } as unknown as DefinitionPatch),
    ])

    expect(rows[0]?.image).toBeNull()
  })

  it('survives a definition without any config file', () => {
    const rows = buildAgentRows([definitionOf({ id: 'fake', configFiles: [] })])

    expect(rows[0]?.statePaths).toEqual([])
  })
})
