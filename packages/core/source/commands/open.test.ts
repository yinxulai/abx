/**
 * `abx open` 的干跑用例。
 *
 * 干跑是唯一能在本机（没有 docker 守护进程）跑通整条编排路径的地方，
 * 所以「这次会话会往舱里挂哪一份配置」必须在干跑的输出里写清楚：
 * 用户按下回车之前，那是他唯一能核对的地方。
 */

import { describe, expect, it } from 'vitest'
import { makeConfig, makeUpstream } from '@abx/contracts/test-support'
import type { CommandOptions } from './options'
import { runOpen } from './open'
import type { CommandContext } from './runtime'

function context(): CommandContext {
  return {
    config: makeConfig({ upstreams: [makeUpstream({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })] }),
    configPath: '/tmp/abx.config.json',
    env: {},
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
    cellHost: null,
    tokenFile: null,
    ...overrides,
  }
}

async function dryRun(agentId: string): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const code = await runOpen({
    options: options({ positionals: [agentId], dryRun: true }),
    context: context(),
    log: (message) => lines.push(message),
  })
  return { code, output: lines.join('\n') }
}

describe('runOpen --dry-run', () => {
  it('写出会生成的那份配置，并说明它是只读的、不是宿主那份', async () => {
    const { code, output } = await dryRun('claude')
    expect(code).toBe(0)
    expect(output).toContain('.claude/settings.json')
    expect(output).toContain('只读')
    expect(output).toContain('宿主那份不进舱')
  })

  it('点明不挂配置目录——同目录里有凭据文件', async () => {
    const { output } = await dryRun('claude')
    expect(output).toContain('也不挂任何配置**目录**（同目录有凭据）')
  })

  it('干跑不落盘', async () => {
    // 干跑的语义是「只说不做」。它会算出配置内容（要报路径），但不写文件——
    // 这条如果破了，用户会在自己主目录里发现一个他没同意创建的东西。
    const { output } = await dryRun('claude')
    expect(output).toContain('没有起任何进程')
    expect(output).not.toContain('.abx/cells')
  })

  it('不认识的 agent 直接报错，并指出去哪儿加', async () => {
    await expect(dryRun('nope')).rejects.toThrow(/不认识的 agent/)
  })
})
