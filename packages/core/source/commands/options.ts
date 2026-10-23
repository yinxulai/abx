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
  /** broker：覆盖舱面绑定地址。 */
  readonly cellHost: string | null
  /** broker：舱令牌落盘位置。 */
  readonly tokenFile: string | null
}
