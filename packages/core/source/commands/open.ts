/**
 * `abx open <agent> [dir]` —— 整套东西的入口。
 *
 * 流程（也是打印给用户看的那份）：
 *   1. 确保 broker 在跑
 *   2. 创建会话
 *   3. 注入环境变量
 *   4. 在舱内启动 agent
 *   5. agent 退出后销毁会话
 *
 * 「销毁会话」在 docker 后端上就是容器退出时 `--rm` 生效；local 后端本来就没有
 * 需要销毁的东西。所以第 5 步在代码里是「确认它确实销毁了」，而不是「执行销毁」——
 * 这个区别值得留意，因为它决定了「漏掉第 5 步」会不会变成一个真实的安全问题。
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { findAgent, agentIds } from '@abx/contracts'
import { collectSecretEnvNames } from '../broker/index'
import {
  buildCellEnv,
  cellRootFor,
  createBackend,
  findRiskyFilesInTaskDir,
  generateCellId,
  renderAgentConfig,
  stageAgentConfig,
  toSandboxConfigFiles,
} from '../session/index'
import type { CommandOptions } from './options'
import { CommandError, cellOriginFor, ensureBroker, resolveBackend, resolveCellHost, type CommandContext } from './runtime'

export interface OpenInput {
  readonly options: CommandOptions
  readonly context: CommandContext
  readonly log: (message: string) => void
}

export async function runOpen(input: OpenInput): Promise<number> {
  const { options, context, log } = input
  const agentId = options.positionals[0]
  if (agentId === undefined) throw new CommandError('abx open 需要指定 agent')

  const agent = findAgent(agentId)
  if (agent === null) {
    throw new CommandError(
      `不认识的 agent：${agentId}。当前支持：${agentIds().join(' / ')}`,
      '新增 agent 请往 packages/contracts/source/agents.ts 的注册表里加一条。',
    )
  }
  if (agent.status === 'unconfirmed') {
    log(`[abx] 注意：${agent.id} 的定义还没核实过。${agent.note}`)
  }

  const taskDir = path.resolve(options.positionals[1] ?? context.cwd)
  if (!existsSync(taskDir)) throw new CommandError(`任务目录不存在：${taskDir}`)
  if (!statSync(taskDir).isDirectory()) throw new CommandError(`任务目录不是一个目录：${taskDir}`)

  // 上游必须存在。`claude` 需要 `anthropic` 这个上游，配置里没有的话
  // 后面每一步都会失败，不如现在就说清楚。
  const upstream = context.config.upstreams.find((candidate) => candidate.id === agent.upstreamId)
  if (upstream === undefined) {
    throw new CommandError(
      `配置里没有 id 为 ${agent.upstreamId} 的上游，${agent.id} 需要它。`,
      `在 ${context.configPath} 的 upstreams 里加上一条，并把它的域名写进 egress.allow。`,
    )
  }

  const backendId = resolveBackend(context.config, options.backend)
  const cellHost = resolveCellHost(context.config, backendId, null)
  const cellId = generateCellId(agent.id)

  // 任务目录里如果躺着凭据文件，说一声。不是拦截——目录是用户自己选的，
  // 但舱内拿到的是可写权限，改坏了回不来。
  const risky = findRiskyFilesInTaskDir(taskDir)

  if (options.dryRun) {
    // 干跑只生成**内容**、不落盘：这时候还没有舱令牌（broker 还没起），
    // 而清单里要报的是路径，路径不依赖令牌。
    const plan = renderAgentConfig({
      agentId: agent.id,
      cellOrigin: cellOriginFor(context.config, cellHost),
      upstreamId: upstream.id,
      // 舱内的 home 来自配置，**不是**宿主 home：这一处漏传过一次，生成的配置
      // 落到了宿主的 `~/.claude/`，而舱内 agent 读的是另一个地方。
      cellHome: context.config.session.cellHome,
    })
    log(renderPlan({ agentId: agent.id, taskDir, backendId, cellHost, context, cellId, configPaths: plan.files.map((file) => file.cellPath) }))
    return 0
  }

  if (backendId === 'local') {
    log('')
    log('⚠  local 后端不是沙箱，禁止用于演示。')
    log('   命令会以当前用户身份直接在宿主上执行，没有文件系统隔离、没有资源限额、没有网络隔离。')
    log('   它只用来在 docker 不可用时验证会话编排的逻辑。')
    log('')
  }
  for (const name of risky) {
    log(`[abx] 提醒：任务目录里有 ${name}，舱内以可写方式挂载该目录，agent 能读到也能改到它。`)
  }

  const lease = await ensureBroker({ context, backend: backendId, cellHost, log })
  const cellOrigin = cellOriginFor(context.config, cellHost)

  // 舱的令牌从注册表来，不再复用宿主固定令牌。`binding.cellId` 与令牌绑定，
  // 也是审计里会出现的身份；正常情况下就是这次的 cellId。
  //
  // 顺序不能反：**先注册，再生成配置**。生成出来的配置里必须嵌这个舱自己的令牌 ——
  // 用宿主固定令牌的话，舱内请求会落到 `default` 舱上，审计里的归属就是错的。
  const binding = lease.registerCell(cellId)

  // 生成配置 → 落盘 → 只读挂进去。**宿主那份 settings.json 一个字都不进舱**：
  // 里面可能写着别家的 key 和别的端点，而同目录还躺着凭据文件（见 session/agent-config.ts）。
  //
  // 只在 docker 后端生成：local 后端直接在宿主上跑，没有挂载这回事，
  // 写一份没人读的文件只会让人以为 local 也有那层隔离。
  const staged =
    backendId === 'docker'
      ? stageAgentConfig({
          agentId: agent.id,
          cellRoot: cellRootFor(cellId),
          cellOrigin,
          upstreamId: upstream.id,
          cellToken: binding.token,
          tokenInPath: context.config.broker.allowCellTokenInPath,
          cellHome: context.config.session.cellHome,
        })
      : null

  const env = buildCellEnv({
    agent,
    brokerCellOrigin: cellOrigin,
    cellId: binding.cellId,
    cellToken: binding.token,
    upstreamId: upstream.id,
    tokenInPath: context.config.broker.allowCellTokenInPath,
  })

  const backend = createBackend(backendId)
  const session = await backend.create(
    {
      cellId,
      agentId: agent.id,
      command: [agent.command, ...agent.args],
      taskDir,
      workdir: context.config.session.workdir,
      cellHome: context.config.session.cellHome,
      agentConfigFiles: staged === null ? [] : toSandboxConfigFiles(staged),
      env,
      forbiddenEnvNames: collectSecretEnvNames(context.config.upstreams),
      limits: context.config.session.limits,
      image: context.config.session.image,
      user: context.config.session.user,
      network: context.config.session.network,
      tmpfsSizeMb: context.config.session.tmpfsSizeMb,
    },
    { mode: 'inherit' },
  )

  log('')
  log(`[abx] 会话 ${cellId}`)
  log(`[abx] 后端 ${backendId}${lease.spawned ? '（broker 由本次会话启动）' : ''}`)
  log(`[abx] 任务目录 ${taskDir} → ${context.config.session.workdir}（可写，唯一的可写挂载点）`)
  for (const file of staged?.files ?? []) {
    log(`[abx] 配置 ${file.hostPath} → ${file.cellPath}（只读；abx 生成，宿主那份不进舱）`)
  }
  log(`[abx] 上游 ${upstream.id} ← ${upstream.secretEnv ?? upstream.secretFile ?? '(未配置)'}`)
  log(`[abx] 审计 ${context.config.broker.auditPath}`)
  log('')

  // agent 退出后销毁会话。docker 后端靠 `--rm` 在容器退出的那一刻就销毁了，
  // 这里只需要等它退出；local 后端没有需要销毁的东西。
  const exit = await session.exit
  // 舱销毁即注销：令牌随会话结束立刻失效，不会留到下一个会话。
  lease.unregisterCell(cellId)
  // 只关掉自己起的那个。接上别人已经在跑的 broker 时不动它——
  // 那可能是用户前台开着的，杀了会把别的会话一起带走。
  if (lease.spawned) await lease.stop()

  log('')
  if (exit.signal !== null) log(`[abx] agent 被信号 ${exit.signal} 终止`)
  log(`[abx] 会话结束（退出码 ${exit.code ?? '未知'}），容器已随退出销毁。`)
  log(`[abx] 审计流水：abx audit --tail`)

  return exit.code ?? 1
}

interface RenderPlanInput {
  readonly agentId: string
  readonly taskDir: string
  readonly backendId: string
  readonly cellHost: string
  readonly context: CommandContext
  readonly cellId: string
  /** 本来会生成并挂进去的那几个配置文件（只列舱内路径）。 */
  readonly configPaths: readonly string[]
}

function renderPlan(input: RenderPlanInput): string {
  const { context } = input
  const upstream = context.config.upstreams.find((candidate) => candidate.id === findAgent(input.agentId)?.upstreamId)
  return [
    '[abx] --dry-run：下面这些是「本来会做的事」，没有起任何进程。',
    `  会话 id      ${input.cellId}`,
    `  后端         ${input.backendId}${input.backendId === 'local' ? '（不是沙箱，禁止用于演示）' : ''}`,
    `  镜像         ${context.config.session.image}`,
    `  运行用户     ${context.config.session.user}`,
    `  资源限额     内存 ${context.config.session.limits.memory} / pids ${context.config.session.limits.pids} / cpus ${context.config.session.limits.cpus}`,
    `  挂载         ${input.taskDir} → ${context.config.session.workdir}（rw，唯一可写挂载点）`,
    ...(input.backendId === 'docker'
      ? [
          `  生成的配置   ${input.configPaths.join('、')}（只读；abx 现写，宿主那份不进舱）`,
          `  不挂载       /home、用户主目录、docker socket；也不挂任何配置**目录**（同目录有凭据）`,
        ]
      : []),
    `  宿主面       http://${context.config.broker.host}:${context.config.broker.hostPort}`,
    `  舱面         ${cellOriginFor(context.config, input.cellHost)}`,
    `  上游         ${upstream?.id ?? '(缺失)'} ← ${upstream?.secretEnv ?? upstream?.secretFile ?? '(未配置)'}`,
    `  出口白名单   ${context.config.egress.map((rule) => rule.pattern).join(', ') || '(空：全部拒绝)'}`,
    `  审计         ${context.config.broker.auditPath}`,
  ].join('\n')
}
