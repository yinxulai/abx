/**
 * `abx open` 的干跑与实例目录接线用例。
 *
 * 干跑是唯一能在本机（没有 docker 守护进程）跑通整条编排路径的地方，
 * 所以「这次会话会往舱里挂哪一份配置、挂哪个实例目录」必须在干跑的输出里写清楚：
 * 用户按下回车之前，那是他唯一能核对的地方。
 *
 * 另一件事是「干跑真的什么都不建」——它会在输出里报一堆宿主路径，
 * 而其中任何一条都不该在这时候被创建出来。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeConfig, makeUpstream } from '@abx/contracts/test-support'
import type { CommandOptions } from './options'
import { runOpen } from './open'
import type { CommandContext } from './runtime'

/** 测试用的「舱内 home」。刻意**不是**默认值，这样「有没有把配置传进去」才看得出来。 */
const CELL_HOME = '/home/dev'

/** 临时实例根。用例绝不能往开发者真实的 `~/.abx/instances` 里写。 */
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  tempRoots.length = 0
})

function instancesRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'abx-open-'))
  tempRoots.push(root)
  return path.join(root, 'instances')
}

function context(env: Readonly<Record<string, string | undefined>> = {}, sessionImage: string | null = null): CommandContext {
  return {
    config: makeConfig({
      upstreams: [makeUpstream({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })],
      session: { cellHome: CELL_HOME, image: sessionImage },
    }),
    configPath: '/tmp/abx.config.json',
    env,
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
    instance: null,
    cellHost: null,
    tokenFile: null,
    ...overrides,
  }
}

interface DryRunOptions {
  readonly instance?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 配置里的 `session.image`。不传 = 不写，镜像由 agent 清单决定。 */
  readonly image?: string
}

async function dryRun(agentId: string, overrides: DryRunOptions = {}): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const code = await runOpen({
    options: options({ positionals: [agentId], dryRun: true, instance: overrides.instance ?? null }),
    context: context(overrides.env ?? {}, overrides.image ?? null),
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

  it('配置挂在**舱内** home 下，用的是配置里的 session.cellHome', async () => {
    // 这条是那个真空洞的回归测试：`open.ts` 曾经没把 cellHome 传下去，
    // 于是干跑里报的是一个宿主路径，而舱内 agent 读的是另一个地方。
    // 这里换成一个非默认值，好让「没传」和「传了」在输出里长得不一样。
    const { output } = await dryRun('claude')
    expect(output).toContain(`${CELL_HOME}/.claude/settings.json`)
  })

  it('干跑不落盘', async () => {
    // 干跑的语义是「只说不做」。它会算出配置内容（要报路径），但不写文件——
    // 这条如果破了，用户会在自己主目录里发现一个他没同意创建的东西。
    const { output } = await dryRun('claude')
    expect(output).toContain('没有起任何进程')
    expect(output).not.toContain('.abx/cells')
  })

  it('报出实例目录与舱内挂载点，且**一个目录都不建**', async () => {
    const root = instancesRoot()
    const { output } = await dryRun('claude', { env: { ABX_INSTANCES_ROOT: root } })

    expect(output).toContain(path.join(root, 'claude', 'claude'))
    expect(output).toContain(`${CELL_HOME}/.claude`)
    expect(output).toContain('可写')
    // 干跑报的是路径，不是既成事实：实例根下面一个字节都不该出现。
    expect(existsSync(root)).toBe(false)
  })

  it('默认实例就是 agent 自己：再开一次接的是同一份历史', async () => {
    // 两次干跑的 cellId 一定不同（它是审计身份），但实例目录必须一样——
    // 这一条就是「历史接得上」的全部内容。
    const root = instancesRoot()
    const first = await dryRun('claude', { env: { ABX_INSTANCES_ROOT: root } })
    const second = await dryRun('claude', { env: { ABX_INSTANCES_ROOT: root } })
    const stateDir = path.join(root, 'claude', 'claude')

    expect(first.output).toContain(stateDir)
    expect(second.output).toContain(stateDir)
    expect(first.output).toContain('实例 id      claude')
    expect(second.output).toContain('实例 id      claude')
  })

  it('--instance 指定别的名字时用给定的那个，不做兜底改写', async () => {
    const root = instancesRoot()
    const { output } = await dryRun('claude', { instance: 'work-1', env: { ABX_INSTANCES_ROOT: root } })
    expect(output).toContain('实例 id      work-1')
    expect(output).toContain(path.join(root, 'work-1', 'claude'))
  })

  it('实例流水只在宿主，干跑里明确不挂进舱', async () => {
    const root = instancesRoot()
    const { output } = await dryRun('claude', { env: { ABX_INSTANCES_ROOT: root } })
    expect(output).toContain(path.join(root, 'claude', 'sessions.jsonl'))
    expect(output).toContain('只写宿主，不挂进舱')
  })

  it('非法实例 id 在起任何东西之前就报错', async () => {
    await expect(dryRun('claude', { instance: '../../etc' })).rejects.toThrow(/不是合法的实例 id/)
    await expect(dryRun('claude', { instance: 'a/b' })).rejects.toThrow(/不是合法的实例 id/)
  })

  it('实例根被配成宿主 home 时，干跑就报错——配错了要在按下回车之前知道', async () => {
    await expect(dryRun('claude', { env: { ABX_INSTANCES_ROOT: homedir() } })).rejects.toThrow(/宿主 home/)
  })

  it('不认识的 agent 直接报错，并指出去哪儿加', async () => {
    await expect(dryRun('nope')).rejects.toThrow(/不认识的 agent/)
  })

  it('配置里不写镜像时，用所选 agent 清单里那个（每个 agent 自己的镜像）', async () => {
    // 这条是旧默认值 `node:22-slim` 的回归测试：那个默认值会让 `abx open claude`
    // 起一个没有 claude 命令的空壳，看起来还挺正常。
    const { output } = await dryRun('claude')
    expect(output).toContain('镜像         abx-agent-claude:2.1.308')
  })

  it('配置里显式写了镜像就以配置为准（跑裸容器做验证的出口）', async () => {
    const { output } = await dryRun('claude', { image: 'node:22-slim' })
    expect(output).toContain('镜像         node:22-slim')
    expect(output).not.toContain('abx-agent-claude')
  })
})
