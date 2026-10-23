/**
 * 实例（instance）：**跨会话**活下来的那个身份。
 *
 * 需求原文是「每个实例都持久化目录，确保每次打开服务，记录历史都还在」。
 *
 * 三个概念要先分清，它们常被混成一个：
 *
 *   - **agent**（`claude` / `codex` / `dsh`）：用哪个工具；
 *   - **instance**（默认就是 agentId）：哪一份历史。再开一次 `claude` 还是同一个
 *     实例，于是第二次接着第一次往下写；
 *   - **cell**（`cellId`，每次新随机）：这一次运行。它是**审计身份**，不能复用——
 *     复用的话审计里「哪个会话在什么时候碰了哪个域名」就再也分不出是哪一次了。
 *
 * 所以落盘按**实例**分，记账按 cell 分，两者不是一回事。
 *
 * 目录形状：
 *
 *   ~/.abx/instances/<instanceId>/
 *   ├─ claude/            挂到舱内 <cellHome>/.claude，**可写**（历史写在这里）
 *   │  └─ settings.json   abx 生成，在它内部再套一层**只读**挂载
 *   └─ sessions.jsonl     abx 自己的流水，**只在宿主写，不进舱**
 *
 * **为什么不靠「不删容器」**：`--rm` 删的是容器，而容器本来就不是要留下的东西
 * （它是一次运行的壳）。要留下的是**宿主上的目录**。所以这条路对数得起
 * `--rm` + `--read-only`：两者一个字节都不用动，隔离性质没有任何让步。
 *
 * **为什么挂整个 agent 主目录，而不是列一串子路径**：历史落点是 agent 自己的实现
 * 细节（claude 在 `~/.claude/projects/`、`sessions/`、`shell-snapshots/` 各处写，
 * codex 在 `~/.codex/sessions/` 写，而且换一个版本就可能多一个）。列一串子路径
 * 就是一份会过期的清单，漏一个的后果是**那部分历史静默消失**——比不持久化更坏，
 * 因为用户以为它在。挂整个主目录的代价是「舱内能改到自己主目录里的任何东西」，
 * 而这个舱里本来就只有 agent 自己写的东西。
 *
 * 危险的那一面不在这里：这些目录会变成**可写挂载源**，所以 `mount-policy.ts`
 * 对它们有专门几道闸（必须在实例根之下、realpath 之后不得逃逸、不得是宿主 home、
 * 不得命中凭据文件名）。这个文件只负责「路径算对 + 建出来 + 记账」。
 */

import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentDefinition } from '@abx/contracts'
import { agentHomePath } from './agent-config'

/**
 * 覆盖实例根的环境变量。
 *
 * 存在的理由是测试：用例要把实例目录指到一个临时目录里，不能往开发者真实的
 * `~/.abx/instances` 里写。顺带也给了「实例放别的盘上」一个出口。
 */
export const INSTANCES_ROOT_ENV = 'ABX_INSTANCES_ROOT'

export class InstanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstanceError'
  }
}

/**
 * 实例根：默认 `~/.abx/instances`。
 *
 * 放在 `~/.abx/` 下面有两个理由，和 abx 其他自用的目录一样：它跟着 home 走
 * （macOS 上 Docker Desktop 只把 home 下的路径共享给虚拟机），以及它不混进用户
 * 的项目目录——abx 自己写的东西不该出现在别人的仓库里。
 */
export function defaultInstancesRoot(env: Readonly<Record<string, string | undefined>> = process.env, homeDir: string = homedir()): string {
  const fromEnv = env[INSTANCES_ROOT_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(homeDir, '.abx', 'instances')
}

/**
 * 实例 id 的写法。它要直接当一段目录名用。
 *
 * 只认一段普通文件名：`..`、带 `/` 的、空串一律不合法。与其在拼路径时「顺手
 * basename 一下」（那样 `../../etc` 会静默变成 `etc`，用户以为自己指定了别的
 * 实例），不如在这里说清楚它不合法。
 */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidInstanceId(instanceId: string): boolean {
  return INSTANCE_ID_PATTERN.test(instanceId)
}

export interface InstancePlanInput {
  readonly agent: AgentDefinition
  /** 哪一份历史。默认由调用方传 agentId。 */
  readonly instanceId: string
  /** 舱内那个 home（`session.cellHome`）。 */
  readonly cellHome: string
  readonly instancesRoot: string
}

export interface InstancePlan {
  readonly instanceId: string
  readonly agentId: string
  readonly instancesRoot: string
  /** `<instancesRoot>/<instanceId>`：这个实例在宿主上的全部东西。 */
  readonly root: string
  /** `<root>/<agentId>`：舱内主目录在宿主上的对应物，以 rw 挂进舱。 */
  readonly stateDir: string
  /** 舱内挂载点，例如 `/home/node/.claude`。 */
  readonly cellPath: string
  /** `<root>/sessions.jsonl`：abx 自己的流水。 */
  readonly sessionLogPath: string
}

/**
 * 算出路径，不碰文件系统——干跑（`--dry-run`）也要用它列清单，
 * 而干跑的语义是「只说不做」。
 */
export function planInstance(input: InstancePlanInput): InstancePlan {
  if (!isValidInstanceId(input.instanceId)) {
    throw new InstanceError(
      `不是合法的实例 id：${JSON.stringify(input.instanceId)}。` +
        `只能用字母、数字、点、下划线、连字符，且以字母或数字开头（它要当目录名用）。`,
    )
  }

  const root = path.join(input.instancesRoot, input.instanceId)
  return {
    instanceId: input.instanceId,
    agentId: input.agent.id,
    instancesRoot: input.instancesRoot,
    root,
    stateDir: path.join(root, input.agent.id),
    cellPath: agentHomePath(input.agent, input.cellHome),
    sessionLogPath: path.join(root, 'sessions.jsonl'),
  }
}

/**
 * 把状态目录建出来（幂等），返回**解析过软链之后**的路径。
 *
 * 权限 `0o700`：里面是 agent 的会话历史，用户和 agent 说过什么、读过哪些文件的
 * 正文都在里面。它不是凭据，但也不该给同一台机器上的别的用户看。
 *
 * 返回 realpath 是给调用方过挂载策略用的：策略要判的正是「解析软链之后还在不在
 * 实例根里面」——`instances/foo/claude` 是个指向 `~/.claude` 的软链时，字面路径
 * 看着完全正常。**先建、再解析、再校验，顺序不能反**：校验必须在往里面写任何
 * 东西（包括生成的配置）之前完成。
 */
export function ensureInstanceStateDir(plan: InstancePlan): string {
  mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 })
  return realpathSync(plan.stateDir)
}

/**
 * abx 自己记的那一行。
 *
 * 记的是**这一次运行**（cellId）而不是「这个实例」：一个实例会有很多行，
 * 按时间排下来就是它的历史。`instanceId` 也在里面，因为记录是按实例存的，
 * 但将来要是合并成一个总账，这一列就是必需的。
 */
export interface InstanceSessionRecord {
  readonly instanceId: string
  /** 这一次运行的审计身份。同一个实例的多次运行各有各的 cellId。 */
  readonly cellId: string
  readonly agentId: string
  readonly backend: string
  /** ISO 8601，宿主时钟。 */
  readonly startedAt: string
  readonly endedAt: string
  readonly exitCode: number | null
  readonly signal: string | null
}

/**
 * 追加一行流水。
 *
 * 用 JSONL 而不是「一份状态文件」：追加不会重写已有内容，进程被杀掉最多丢最后
 * 一行，前面那些还在。反过来，一份每次重写的 JSON 一旦写坏就是全丢。
 *
 * **只写宿主侧**：这个文件在实例根下，不在任何挂载点里（挂进舱的是
 * `<root>/<agentId>`，不是 `<root>`）。它记的是「哪个 cell、什么时候、退出码多少」，
 * 是宿主对这次运行的观察，不是舱内的东西。
 */
export function appendSessionRecord(logPath: string, record: InstanceSessionRecord): void {
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}
