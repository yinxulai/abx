/**
 * `SandboxBackend`：会话编排唯一认识的那个抽象。
 *
 * CLI 只跟这个接口打交道，于是「用 docker 起一个一次性容器」和「在当前用户下直接跑」
 * 这两件安全性质完全相反的事，在上层看起来是同一个东西。代价是这个抽象必须把
 * 「我到底是不是沙箱」这件事**暴露出来**（`isRealSandbox` / `warning`），
 * 否则一个 `abx open --backend local` 的演示会让人以为隔离已经生效了。
 */

import type { ResourceLimits, SandboxBackendId } from '@abx/contracts'

export interface SandboxMount {
  /** 宿主上的绝对路径。 */
  readonly source: string
  /** 舱内的绝对路径。 */
  readonly target: string
  readonly mode: 'ro' | 'rw'
}

/**
 * abx 生成好、落在宿主上的那一个 agent 配置文件。
 *
 * 形状与 `StagedAgentConfigFile` 一致（那是它的产地），这里只留下后端需要的两样。
 *
 * **一个文件一个挂载点，永远是只读的。** 没有任何字段能让调用方要求别的形态——
 * 因为唯一会挂这些东西的地方（docker 后端）按 `mode: 'ro'` 构造挂载参数，
 * 想挂成可写或者挂成目录，都不是「传错一个参数」，而是得改这个类型。
 */
export interface SandboxConfigFile {
  /** 生成文件的宿主路径，形如 `<cellRoot>/agents/<agentId>/settings.json`。 */
  readonly hostPath: string
  /** 舱内挂到哪儿。与宿主那份配置的路径一致（D2）。 */
  readonly cellPath: string
}

/** 进程的输入输出接到哪儿。 */
export type SandboxIo =
  /** 直接接到当前终端：agent 多半需要 TTY。 */
  | { readonly mode: 'inherit' }
  /** 接到回调，测试和未来的 UI 用。 */
  | {
      readonly mode: 'pipe'
      readonly onStdout: (chunk: Buffer) => void
      readonly onStderr: (chunk: Buffer) => void
    }

export interface SandboxSpec {
  /** 这次会话的 id。会出现在容器名、审计和容器标签里。 */
  readonly cellId: string
  readonly agentId: string
  /** 舱内要跑的命令，argv 形式。 */
  readonly command: readonly string[]
  /**
   * 这次会话要挂进舱的 agent 配置文件，由 `stageAgentConfig()` 生成并落盘。
   *
   * 缺省为空数组。docker 后端把它们逐个只读挂进去；local 后端没有挂载这回事，
   * 但它照样把它们算进「本应挂什么」，让两种后端在上层看起来一样。
   */
  readonly agentConfigFiles?: readonly SandboxConfigFile[]
  /** 宿主上的任务目录绝对路径。**唯一**会被挂进舱内的宿主目录。 */
  readonly taskDir: string
  /** 任务目录挂进舱内之后的路径，同时也是工作目录。 */
  readonly workdir: string
  /** 要注入的环境变量。必须已经由 `buildCellEnv` 脱敏过。 */
  readonly env: Readonly<Record<string, string>>
  /**
   * 绝不允许出现在 `env` 里的变量名。
   *
   * 由配置里所有上游的 `secretEnv` 汇总而来。这不是启发式的名字匹配，是精确的
   * 名单——后端在真正起进程之前拿它再查一遍，因为「真实密钥被注进舱内」这件事
   * 一旦发生就无法撤回，值得在最靠近执行点的地方再挡一次。
   */
  readonly forbiddenEnvNames: readonly string[]
  readonly limits: ResourceLimits
  readonly image: string
  readonly user: string
  readonly network: string
  readonly tmpfsSizeMb: number
}

export interface SandboxExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface SandboxHandle {
  readonly cellId: string
  readonly backendId: SandboxBackendId
  readonly mounts: readonly SandboxMount[]
  /** 实际注入的环境变量（脱敏后的），排查用。 */
  readonly env: Readonly<Record<string, string>>
  /** 命令退出时 resolve。 */
  readonly exit: Promise<SandboxExit>
  /** 主动终止。已经退出时是空操作。 */
  stop(): Promise<void>
}

export interface SandboxBackend {
  readonly id: SandboxBackendId
  /**
   * 这个后端提供的到底是不是隔离。
   *
   * `false` 的后端只应该出现在开发和自测里；CLI 拿到 `false` 会强制打警告。
   */
  readonly isRealSandbox: boolean
  /** 不是真沙箱时必须给出一句能贴到终端上的警告。 */
  readonly warning: string | null
  create(spec: SandboxSpec, io: SandboxIo): Promise<SandboxHandle>
}

/** 后端在起进程之前统一走一遍的检查。 */
export function assertNoForbiddenEnv(spec: SandboxSpec): void {
  const leaked = Object.keys(spec.env).filter((name) => spec.forbiddenEnvNames.includes(name))
  if (leaked.length === 0) return

  // 报变量名，不报值。
  throw new Error(
    `拒绝启动：环境变量 ${leaked.join(', ')} 是配置里的凭据来源，不能注入舱内。` +
      `舱内应当只拿到 broker 的地址和一个占位符。`,
  )
}
