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
import { MCP_SHIM_CELL_PATH, MCP_SHIM_FILE_NAME, type SessionConfig } from '@abx/contracts'
import { makeConfig, makeUpstream } from '@abx/contracts/test-support'
import { RUNNING_PLATFORM } from '../test-support'
import type { CommandOptions } from './options'
import { runOpen } from './open'
import { CommandError, type CommandContext } from './runtime'

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
    // 任务目录默认就是 cwd，而 `runOpen` 真的会 `existsSync` 它——所以这里必须是
    // 一个真存在、且每个平台都有的目录。写死 `/tmp` 的话 Windows 上会解析成
    // `D:\tmp`，于是每条用例先撞上「任务目录不存在」。
    cwd: tmpdir(),
    // 平台由宿主层给（`apps/app` 里读一次 `process.platform`）；测试里给的就是
    // 跑测试这台机器。
    platform: RUNNING_PLATFORM,
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

  it('报出传递窗的 shim 从哪儿挂进舱，用的是这次会话 id 那一格', async () => {
    // 挂载源与「会话 id」必须对得上：挂进去的是哪一份脚本，出错时要能一眼看出来。
    const root = path.join(instancesRoot(), 'runtime')
    const { output } = await dryRun('claude', { env: { ABX_RUNTIME_ROOT: root } })
    const cellId = output.match(/会话 id\s+([^\s（]+)/)?.[1]

    expect(cellId).toBeTruthy()
    expect(output).toContain(`${path.join(root, cellId ?? '', MCP_SHIM_FILE_NAME)} → ${MCP_SHIM_CELL_PATH}`)
    expect(output).toContain('只读')
  })

  it('报出交付格：publish 出来的东西会落到哪儿', async () => {
    const outbox = path.join(instancesRoot(), 'outbox')
    const { output } = await dryRun('claude', { env: { ABX_OUTBOX_ROOT: outbox } })
    const cellId = output.match(/会话 id\s+([^\s（]+)/)?.[1]

    expect(cellId).toBeTruthy()
    expect(output).toContain(path.join(outbox, cellId ?? ''))
  })

  it('干跑不建运行时目录、也不建交付格', async () => {
    // 干跑的语义是「只说不做」。它会报出这两条路径，其中任何一条都不该被创建。
    const root = instancesRoot()
    const { output } = await dryRun('claude', {
      env: { ABX_RUNTIME_ROOT: root, ABX_OUTBOX_ROOT: path.join(root, 'outbox') },
    })

    expect(output).toContain('abx-mcp-shim.mjs')
    expect(existsSync(root)).toBe(false)
  })
})

/**
 * 镜像还没构建的那个 agent（清单里钉的是 `unbuilt`）单独一组用例。
 *
 * 这组用例守的是一件具体的事：**报错要长成人话**。以前 `abx open <这个 agent>`
 * 会一路走到起容器，docker 回一句「拉不到 <仓库>:unbuilt」——那句话读起来像网络
 * 不通、或者镜像名写错了，而真正的原因是「这个 agent 的镜像从来没人构建过」。
 */
describe('runOpen：镜像还没构建', () => {
  type EnvLike = Readonly<Record<string, string | undefined>>

  /**
   * 那个 agent 的上下文。上游 id 用清单里登记的那个（`dsh`）——
   * 少配上游会先撞上另一道检查，这条用例就验不到镜像那道闸了。
   */
  function unbuiltContext(session: Partial<SessionConfig> = {}, env: EnvLike = {}): CommandContext {
    return {
      config: makeConfig({
        upstreams: [makeUpstream({ id: 'dsh', baseUrl: 'https://api.example.invalid' })],
        session: { cellHome: CELL_HOME, ...session },
      }),
      configPath: '/tmp/abx.config.json',
      env,
      cwd: tmpdir(),
      platform: RUNNING_PLATFORM,
    }
  }

  interface OpenUnbuiltOptions {
    readonly dryRun?: boolean
    readonly session?: Partial<SessionConfig>
    readonly env?: EnvLike
  }

  /** 起一次 `abx open dsh`。默认干跑；`dryRun: false` 走真路径。 */
  async function openUnbuilt(overrides: OpenUnbuiltOptions = {}): Promise<{ code: number; output: string }> {
    const lines: string[] = []
    const code = await runOpen({
      options: options({ positionals: ['dsh'], dryRun: overrides.dryRun ?? true }),
      context: unbuiltContext(overrides.session ?? {}, overrides.env ?? {}),
      log: (message) => lines.push(message),
    })
    return { code, output: lines.join('\n') }
  }

  it('在起任何东西之前就失败，并说清该跑哪条命令', async () => {
    const root = instancesRoot()

    // 走的是**真**路径（不是干跑）：这道闸要在建实例目录、起 broker、拼 docker
    // 命令之前就抛出。闸不在的话，这里会一路走到起容器，报出来的就是 docker
    // 那句「拉不到镜像」——正是这条用例要拦住的东西。
    const thrown = await openUnbuilt({ dryRun: false, env: { ABX_INSTANCES_ROOT: root } }).catch(
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CommandError)
    const failure = thrown as CommandError
    expect(failure.message).toContain('dsh 的镜像还没构建')
    expect(failure.message).toContain('abx-agent-dsh:unbuilt')
    // 该跑哪条命令写在 hint 里，它跟着 agent id 走（换一个 agent 就是另一个 id）。
    expect(failure.hint).toContain('bash packages/toolkit/scripts/build-agent-image.sh dsh')

    // 「没有真的调用 docker」在这里的证据是它**没走到那一步**：实例目录是起容器
    // 之前建的（`ensureInstanceStateDir`），这条路一个字节都没落盘。
    expect(existsSync(root)).toBe(false)
  })

  it('干跑也拦住：它说的是「这次起不来」，不是「计划长什么样」', async () => {
    await expect(openUnbuilt()).rejects.toThrow(/镜像还没构建/)
  })

  it('配置里显式给了镜像就不拦：那是跑裸容器的出口，跟清单里钉什么无关', async () => {
    const root = instancesRoot()
    const { code, output } = await openUnbuilt({
      session: { image: 'node:22-slim' },
      env: { ABX_INSTANCES_ROOT: root },
    })
    expect(code).toBe(0)
    expect(output).toContain('镜像         node:22-slim')
  })

  it('local 后端不拦：它在宿主上跑命令，根本用不上镜像', async () => {
    // 拦下来会让人去构建一个这次会话不会用到的东西——那是一条错的下一步。
    const root = instancesRoot()
    const { code, output } = await openUnbuilt({
      session: { backend: 'local' },
      env: { ABX_INSTANCES_ROOT: root },
    })
    expect(code).toBe(0)
    expect(output).toContain('abx-agent-dsh:unbuilt')
    expect(output).toContain('local')
  })
})

/**
 * 配置里没有 agent 要的那个上游。
 *
 * 这条报错是「起舱时配置缺东西怎么查」在**运行时**的那一份：文档里那一节已经
 * 删了（那句「未配置上游」的话术不再属于产品），所以修法只能长在这里——
 * 说清改哪份文件、改哪个字段、还得放行哪个域名。这条用例就是给它上锁：
 * 三样里少一样，用户拿到的是一个「哪儿都不对」的错误。
 */
describe('runOpen：配置里没有 agent 要的上游', () => {
  it('报错里带上修法：哪份配置、哪个字段、还要放行哪个域名', async () => {
    // 路径刻意**不是**那个默认值：写死一句同样的话也会让断言变绿，
    // 换个值才看得出它真是从 `context.configPath` 里取的。
    const configPath = '/tmp/another-abx.config.json'

    const thrown = await runOpen({
      options: options({ positionals: ['claude'], dryRun: true }),
      context: {
        ...context(),
        configPath,
        // 上游表里有别的 id，就是没有 `claude` 要的 `anthropic`。
        config: makeConfig({
          upstreams: [makeUpstream({ id: 'openai', baseUrl: 'https://api.example.invalid' })],
          session: { cellHome: CELL_HOME },
        }),
      },
      log: () => {},
    }).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(CommandError)
    const failure = thrown as CommandError
    const text = [failure.message, failure.hint].filter((part) => part !== null).join('\n')

    // 三个要素齐了才叫「给出了修法」。
    expect(text).toContain(configPath)
    expect(text).toContain('upstreams')
    expect(text).toContain('egress.allow')
    // 缺的是哪个上游也得写出来，不然不知道该往表里加哪一条。
    expect(text).toContain('anthropic')

    // 「未配置上游」是随那一节文档一起删掉的话术，不许回流；报错也不该是空的。
    expect(text).not.toContain('未配置上游')
    expect(text).not.toBe('')
  })
})
