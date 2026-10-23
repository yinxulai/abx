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
  appendSessionRecord,
  assertInstancesRoot,
  assertStateDirPolicy,
  buildCellEnv,
  createBackend,
  defaultInstancesRoot,
  ensureInstanceStateDir,
  findRiskyFilesInTaskDir,
  generateCellId,
  isValidInstanceId,
  planInstance,
  renderAgentConfig,
  stageAgentConfig,
  toSandboxConfigFiles,
} from '../session/index'
import type { InstancePlan, InstanceSessionRecord, SandboxStateDir } from '../session/index'
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
  // 舱内的 home 来自配置，**不是**宿主 home：这一处漏传过一次，生成的配置
  // 落到了宿主的 `~/.claude/`，而舱内 agent 读的是另一个地方。下面每一处用到
  // 「~」的地方都必须用这个值。
  const cellHome = context.config.session.cellHome

  // 实例 = 哪一份历史。默认就是 agent 自己，于是「再开一次 claude」接的是上一次
  // 那份历史——这正是持久化要的效果。它和 cellId 是两回事：cellId 每次运行都是
  // 新的（那是**审计身份**，复用会让审计里两个会话再也分不开）。
  //
  // 非法 id 在这里就报，而不是等拼路径时「顺手 basename 一下」：那样 `../../etc`
  // 会静默变成 `etc`，用户以为自己开的是另一个实例。
  if (options.instance !== null && !isValidInstanceId(options.instance)) {
    throw new CommandError(
      `不是合法的实例 id：${JSON.stringify(options.instance)}`,
      '只能用字母、数字、点、下划线、连字符，且以字母或数字开头——它要当目录名用。',
    )
  }
  const instance = planInstance({
    agent,
    instanceId: options.instance ?? agent.id,
    cellHome,
    instancesRoot: defaultInstancesRoot(context.env),
  })

  // 实例根先过闸。它来自 `ABX_INSTANCES_ROOT`，而「配成 /home」这种写法会让**整个
  // 主目录**变成可写挂载源的来源。这一步只解析路径、不碰文件系统，所以干跑也跑它：
  // 配错了应该在按下回车之前就知道。
  assertInstancesRoot(instance.instancesRoot)

  // 任务目录里如果躺着凭据文件，说一声。不是拦截——目录是用户自己选的，
  // 但舱内拿到的是可写权限，改坏了回不来。
  const risky = findRiskyFilesInTaskDir(taskDir)

  if (options.dryRun) {
    // 干跑只生成**内容**、不落盘：这时候还没有舱令牌（broker 还没起），
    // 而清单里要报的是路径，路径不依赖令牌。实例目录也一个都不建。
    const plan = renderAgentConfig({
      agentId: agent.id,
      cellOrigin: cellOriginFor(context.config, cellHost),
      upstreamId: upstream.id,
      cellHome,
    })
    log(
      renderPlan({
        agentId: agent.id,
        taskDir,
        backendId,
        cellHost,
        context,
        cellId,
        instance,
        configPaths: plan.files.map((file) => file.cellPath),
      }),
    )
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

  // 实例状态目录：**先建、再解析软链、再校验，最后才往里写东西**。顺序反了就有洞——
  // 生成的配置就写在里面，等起容器前那道闸才发现路径不对时，文件已经顺着软链
  // 写到别处去了。所以这一步在所有写入之前，也在起 broker 之前（早失败早退出）。
  //
  // 只有 docker 后端需要它：它是**挂载源**。local 后端没有挂载这回事，
  // 建一个不会有人读的目录只会让人以为 local 也能留下历史。
  const stateDirs: SandboxStateDir[] = []
  if (backendId === 'docker') {
    const stateDir: SandboxStateDir = {
      // realpath：闸门要判的正是「解析软链之后还在不在实例根里面」。
      hostPath: ensureInstanceStateDir(instance),
      cellPath: instance.cellPath,
      agentId: agent.id,
    }
    assertStateDirPolicy({ stateDirs: [stateDir], instancesRoot: instance.instancesRoot, cellHome })
    stateDirs.push(stateDir)
  } else {
    log(`[abx] local 后端不挂载实例目录：这个后端的会话历史不会跨会话保留。`)
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
  // 落盘位置是**实例状态目录里面**：那个目录整个 rw 进舱（历史写在里面），
  // 而这一份文件在它内部再套一层 ro 挂载，所以仍然改不动。
  //
  // 只在 docker 后端生成：local 后端直接在宿主上跑，没有挂载这回事，
  // 写一份没人读的文件只会让人以为 local 也有那层隔离。
  //
  // 写进**解析过软链的那个路径**（也就是挂载源本身）：两处必须是同一个字符串，
  // 否则「配置文件到底在不在那个可写挂载里面」就变成一件要靠推断的事。
  const staged =
    backendId === 'docker'
      ? stageAgentConfig({
          agentId: agent.id,
          directory: stateDirs[0]?.hostPath ?? instance.stateDir,
          cellOrigin,
          upstreamId: upstream.id,
          cellToken: binding.token,
          tokenInPath: context.config.broker.allowCellTokenInPath,
          cellHome,
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
  const startedAt = new Date().toISOString()
  // 有没有终端由 CLI 自己判断：交互态给 `--tty`，托盘（管道 spawn）、CI、脚本不给。
  // 无脑加 `--tty` 会让 docker 直接拒绝起容器——那不是「少了颜色」，是舱根本起不来。
  const allocateTty = process.stdin.isTTY === true
  const session = await backend.create(
    {
      cellId,
      agentId: agent.id,
      command: [agent.command, ...agent.args],
      allocateTty,
      taskDir,
      workdir: context.config.session.workdir,
      cellHome,
      agentConfigFiles: staged === null ? [] : toSandboxConfigFiles(staged),
      stateDirs,
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
  log(`[abx] 实例 ${instance.instanceId}（历史目录 ${instance.root}）`)
  log(`[abx] 后端 ${backendId}${lease.spawned ? '（broker 由本次会话启动）' : ''}`)
  log(`[abx] 任务目录 ${taskDir} → ${context.config.session.workdir}（可写）`)
  for (const dir of stateDirs) {
    log(`[abx] 实例目录 ${dir.hostPath} → ${dir.cellPath}（可写；历史留在这儿，所以能跨会话）`)
  }
  for (const file of staged?.files ?? []) {
    log(`[abx] 配置 ${file.hostPath} → ${file.cellPath}（只读；abx 生成，宿主那份不进舱）`)
  }
  log(`[abx] 上游 ${upstream.id} ← ${upstream.secretEnv ?? upstream.secretFile ?? '(未配置)'}`)
  log(`[abx] 审计 ${context.config.broker.auditPath}`)
  log('')

  // agent 退出后销毁会话。docker 后端靠 `--rm` 在容器退出的那一刻就销毁了，
  // 这里只需要等它退出；local 后端没有需要销毁的东西。
  const exit = await session.exit
  // abx 自己的记账：这一次运行（cellId）什么时候开始、什么时候结束、退出码多少，
  // 追加到实例目录下的流水里。**只在宿主写**——它在 `<实例目录>/sessions.jsonl`，
  // 而挂进舱的是 `<实例目录>/<agentId>` 那一层，所以舱内看不到它。
  const record: InstanceSessionRecord = {
    instanceId: instance.instanceId,
    cellId,
    agentId: agent.id,
    backend: backendId,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: exit.code,
    signal: exit.signal,
  }
  appendSessionRecord(instance.sessionLogPath, record)
  // 舱销毁即注销：令牌随会话结束立刻失效，不会留到下一个会话。
  lease.unregisterCell(cellId)
  // 只关掉自己起的那个。接上别人已经在跑的 broker 时不动它——
  // 那可能是用户前台开着的，杀了会把别的会话一起带走。
  if (lease.spawned) await lease.stop()

  log('')
  if (exit.signal !== null) log(`[abx] agent 被信号 ${exit.signal} 终止`)
  log(`[abx] 会话结束（退出码 ${exit.code ?? '未知'}），容器已随退出销毁。`)
  log(`[abx] 实例流水：${instance.sessionLogPath}`)
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
  readonly instance: InstancePlan
  /** 本来会生成并挂进去的那几个配置文件（只列舱内路径）。 */
  readonly configPaths: readonly string[]
}

function renderPlan(input: RenderPlanInput): string {
  const { context } = input
  const upstream = context.config.upstreams.find((candidate) => candidate.id === findAgent(input.agentId)?.upstreamId)
  const docker = input.backendId === 'docker'
  return [
    '[abx] --dry-run：下面这些是「本来会做的事」，没有起任何进程。',
    `  会话 id      ${input.cellId}（这次的审计身份，每次都新生成）`,
    `  实例 id      ${input.instance.instanceId}（哪一份历史；同一个实例再开一次就接着往下写）`,
    `  后端         ${input.backendId}${input.backendId === 'local' ? '（不是沙箱，禁止用于演示）' : ''}`,
    `  镜像         ${context.config.session.image}`,
    `  运行用户     ${context.config.session.user}`,
    `  舱内 home    ${context.config.session.cellHome}（注入 HOME，也是下面路径里 ~ 展开的地方）`,
    `  资源限额     内存 ${context.config.session.limits.memory} / pids ${context.config.session.limits.pids} / cpus ${context.config.session.limits.cpus}`,
    `  挂载         ${input.taskDir} → ${context.config.session.workdir}（可写，rw）`,
    ...(docker
      ? [
          `  实例目录     ${input.instance.stateDir} → ${input.instance.cellPath}（可写，rw；历史留在这儿，所以能跨会话）`,
          `  生成的配置   ${input.configPaths.join('、')}（只读，ro；abx 现写，宿主那份不进舱）`,
          `  实例流水     ${input.instance.sessionLogPath}（只写宿主，不挂进舱）`,
          `  不挂载       /home、用户主目录、docker socket；也不挂任何配置**目录**（同目录有凭据）`,
        ]
      : [`  实例目录     （local 后端不挂载，历史不会跨会话保留）`]),
    `  宿主面       http://${context.config.broker.host}:${context.config.broker.hostPort}`,
    `  舱面         ${cellOriginFor(context.config, input.cellHost)}`,
    `  上游         ${upstream?.id ?? '(缺失)'} ← ${upstream?.secretEnv ?? upstream?.secretFile ?? '(未配置)'}`,
    `  出口白名单   ${context.config.egress.map((rule) => rule.pattern).join(', ') || '(空：全部拒绝)'}`,
    `  审计         ${context.config.broker.auditPath}`,
  ].join('\n')
}
