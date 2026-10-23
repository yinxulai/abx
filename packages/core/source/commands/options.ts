import type { SandboxBackendId } from '@abx/contracts'

/**
 * 一次命令调用需要的输入。
 *
 * 产品没有命令行，这些值由 `apps/app` 主进程和测试构造。形状仍然是「一次调用要什么」，
 * 但**不含** `command` / `help` / `version` —— 那是命令行的概念，这里不该有。
 */
export interface CommandOptions {
  /** 位置参数。`open` 是 `[agent, dir?]`。 */
  readonly positionals: readonly string[]
  readonly configPath: string | null
  readonly backend: SandboxBackendId | null
  /** audit：只输出原始 JSONL。 */
  readonly json: boolean
  /** audit：持续跟随。 */
  readonly tail: boolean
  /** open：只打印这次会话会做什么，不起任何进程。 */
  readonly dryRun: boolean
  /**
   * open：哪一份历史（`--instance`）。`null` 表示用 agentId。
   *
   * 默认「就是 agent 自己」这件事是设计的一部分：再开一次 `claude` 接的是上一次
   * 那份历史。要并行开两份互不干扰的历史时才显式指定别的名字。
   */
  readonly instance: string | null
  /** broker：覆盖舱面绑定地址。 */
  readonly cellHost: string | null
  /** broker：舱令牌落盘位置。 */
  readonly tokenFile: string | null
}
