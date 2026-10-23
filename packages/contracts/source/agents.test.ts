/**
 * agent 注册表的一致性用例。
 *
 * 这张表是「舱内到底该读哪几个文件」的唯一来源，而它最容易出的错不是写错一个字段，
 * 而是**漏**——漏登一个配置文件，或者把同目录里的凭据文件也当成配置登记进来。
 * 后者尤其致命：挂载策略拿不出「哪些文件是配置」这份名单，就只能靠路径前缀猜，
 * 而凭据文件恰恰就在配置文件的隔壁。
 */

import { describe, expect, it } from 'vitest'
import { AGENT_DEFINITIONS, agentConfigFileNames, agentIds, findAgent, generatedConfigFiles } from './agents'

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
    expect([...agentConfigFileNames()].sort()).toEqual(['config.toml', 'config.yaml', 'settings.json', 'settings.yaml'])
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
