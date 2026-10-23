/**
 * 舱内环境的构造与脱敏。
 *
 * 这个文件是「舱内拿不到任何真实凭据」这条承诺的落点，所以它做两件事，
 * 而且两件都必须做：
 *
 *   1. `scrubEnv` 把宿主的进程环境**剃一遍**再交给舱内。docker 后端本来就不会继承
 *      宿主环境（只传显式 `-e`），但 local 后端会——而 local 后端恰恰是最需要它的那个。
 *   2. `buildCellEnv` 只放进去 broker 的地址和一个占位符。
 *
 * 脱敏分三层，一层比一层狠：
 *   - **精确名单**：配置里所有上游的 `secretEnv`。这些是深层防御的最后一道，
 *     后端在起进程前还会再查一遍（`assertNoForbiddenEnv`）。
 *   - **宿主的危险变量**：ssh-agent、docker、kubeconfig、git askpass 之类。
 *     它们不是「我们配置的凭据」，但同样能让舱内碰到宿主上的东西。
 *   - **名字模式**：`*_TOKEN` / `*_API_KEY` / `*_SECRET` / `*_PASSWORD` …
 *     这一层是启发式的，会有误伤（可能剃掉一个本来无害的变量），
 *     但对 local 后端来说，误伤的代价远小于漏掉一个 `GITHUB_TOKEN`。
 */

import { expandEnvRefs, type AgentDefinition } from '@abx/contracts'

/**
 * 宿主的这些变量绝不进舱。
 *
 * ssh-agent 的 socket 排第一：有了它，舱内的 agent 能以你的身份用你的 SSH 私钥，
 * 而私钥文件一个字节都不用挂进去。
 */
export const DANGEROUS_HOST_ENV_NAMES: readonly string[] = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GPG_AGENT_INFO',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_CONTEXT',
  'KUBECONFIG',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
  'NETRC',
  'HISTFILE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
]

/** 名字长这样的变量一律不进舱。启发式，但在 local 后端下是必要的兜底。 */
const SECRET_NAME_PATTERN = /(_API_KEY|_APIKEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS?|_ACCESS_KEY|_PRIVATE_KEY|_AUTH)$/

export interface ScrubEnvResult {
  readonly env: Record<string, string>
  /** 被剃掉的变量名。给 doctor / 调试看，**不含值**。 */
  readonly removed: readonly string[]
}

/**
 * 把宿主的进程环境剃成可以交给舱内的样子。
 *
 * 这里刻意用的是**黑名单**而不是白名单。白名单更安全，但 local 后端是在真机上跑
 * 一个真实的 agent 命令行：只给 `PATH`/`HOME`/`TERM` 会让一堆工具直接起不来，
 * 而一个起不来的后端会被人绕过——绕过的方式是把命令抄出来手动跑，那样连
 * 这层黑名单都没有了。所以选择是「能跑 + 三层黑名单」，并且把 local 后端
 * 明确标成不是沙箱。
 *
 * docker 后端不受这个取舍影响：它的环境是**显式构造**的（只传 `-e`），
 * 根本没有「继承宿主环境」这条路径。
 *
 * `overrides` 里出现的名字跳过脱敏：那些是我们自己马上要写进去的值
 * （broker 地址、占位符），而 `ANTHROPIC_AUTH_TOKEN` 正好会撞上 `_TOKEN` 模式。
 */
export interface ScrubEnvOptions {
  readonly forbiddenNames?: readonly string[]
  readonly overrides?: Readonly<Record<string, string>>
}

export function scrubEnv(base: Readonly<Record<string, string | undefined>>, options: ScrubEnvOptions = {}): ScrubEnvResult {
  const forbidden = new Set(options.forbiddenNames ?? [])
  const overrides = options.overrides ?? {}
  const environment: Record<string, string> = {}
  const removed: string[] = []

  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (name in overrides) continue

    if (forbidden.has(name) || DANGEROUS_HOST_ENV_NAMES.includes(name) || SECRET_NAME_PATTERN.test(name)) {
      removed.push(name)
      continue
    }
    environment[name] = value
  }

  for (const [name, value] of Object.entries(overrides)) environment[name] = value

  return { env: environment, removed: [...new Set(removed)].sort() }
}

export interface BuildCellEnvOptions {
  readonly agent: AgentDefinition
  /** broker 舱面的地址，例如 `http://172.17.0.1:8789`。 */
  readonly brokerCellOrigin: string
  readonly cellId: string
  readonly cellToken: string
  /** 走哪个上游。 */
  readonly upstreamId: string
  /**
   * 配置里允不允许把舱令牌写进 baseUrl 的路径里（`broker.allowCellTokenInPath`）。
   *
   * 注意它只是「允不允许」。真正要不要这么写，还要看 agent 自己有没有
   * 别的办法把令牌送出去——见 `agent.cellTokenVia`。
   */
  readonly tokenInPath: boolean
}

/**
 * 构造要注入舱内的环境变量。
 *
 * baseUrl 指向 `/u/<upstreamId>`，也就是说 agent 的请求直接落到那个上游路由上，
 * 不需要它自己知道「气闸」这件事。这是刻意的：要让一个现成的 agent 命令行在气闸里
 * 跑起来，唯一可行的办法就是让它以为自己在直连。
 */
export function buildCellEnv(options: BuildCellEnvOptions): Record<string, string> {
  // 两个条件都满足才把令牌写进 URL：配置允许，**并且**这个 agent 没有别的路。
  //
  // 只看配置的话，会写出「头里一份、URL 里又一份」的请求。两个机制同时开着并不
  // 更安全（broker 只认一份），只是白白让令牌多出现在一个地方——而 URL 是
  // 最容易被 agent 自己打印、被上游 access log 收走的那一个。
  const usePath = options.tokenInPath && options.agent.cellTokenVia === 'path'
  const tokenSegment = usePath ? `/c/${options.cellToken}` : ''
  const baseUrl = `${options.brokerCellOrigin}${tokenSegment}/u/${options.upstreamId}`

  const env: Record<string, string> = {
    ABX_CELL_ID: options.cellId,
    ABX_CELL_TOKEN: options.cellToken,
    ABX_BROKER_ORIGIN: options.brokerCellOrigin,
    ABX_UPSTREAM_ID: options.upstreamId,
    [options.agent.baseUrlEnv]: baseUrl,
    // 占位符，不是凭据。broker 无条件覆盖这个头，不校验它的值。
    [options.agent.tokenEnv]: options.agent.placeholderToken,
  }

  // extraEnv 的值可以引用同一批变量，例如
  // `ANTHROPIC_CUSTOM_HEADERS: 'X-Abx-Cell: ${ABX_CELL_TOKEN}'`。
  // 展开在最后做，这样 `${ABX_CELL_TOKEN}` 已经在那儿了。
  for (const [name, template] of Object.entries(options.agent.extraEnv)) {
    env[name] = expandEnvRefs(template, env).value
  }

  return env
}

/**
 * 生成会话 id。
 *
 * 用时间戳 + 随机后缀：既能在审计里一眼看出先后，又不会因为同一秒起了两个会话而撞名。
 * 不用 UUID 是因为它要出现在容器名里，短一点读起来舒服。
 */
export function generateCellId(agentId: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${agentId}-${stamp}-${suffix}`
}
