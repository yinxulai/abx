/**
 * 配置形状。
 *
 * 一条铁律贯穿全文件：**配置里不出现明文密钥**。上游凭据只以「引用」的形式存在，
 * 要么指向一个环境变量名（`secretEnv`），要么指向一个文件路径（`secretFile`）。
 * 真实值只在 broker 转发的那一刻从宿主的进程环境 / 文件系统里读出来，进不了仓库、
 * 进不了日志、也进不了舱内。
 *
 * 可选字段一律写成 `| null` 而不是 `?:`，让「没配」和「配了个空」在类型上就是两件事，
 * 读代码的人不需要去猜 `undefined` 和 `null` 的区别。
 */

/** 上游：舱内请求的落点，以及转发时要注入的凭据从哪儿来。 */
export interface Upstream {
  /** 路由里的那一段：`/u/<id>/...`。 */
  readonly id: string
  /** 目标地址，必须带协议，例如 `https://api.anthropic.com`。 */
  readonly baseUrl: string
  /** 要覆盖的请求头，例如 `authorization`。 */
  readonly authHeader: string
  /** 头里密钥前面的方案，例如 `Bearer`；`null` 表示裸放密钥。 */
  readonly authScheme: string | null
  /** 凭据所在的环境变量名。与 `secretFile` 二选一，且必须选一个。 */
  readonly secretEnv: string | null
  /** 凭据所在的文件路径。与 `secretEnv` 二选一，且必须选一个。 */
  readonly secretFile: string | null
}

/**
 * 出口白名单的一条。
 *
 * `upstreamId` 为 `null` 时是「直通」：放行这个域名，但 broker 不知道该注入谁的凭据，
 * 于是只把舱内的占位符剥掉、原样转发（见 `@abx/broker` 的 route 注释）。
 */
export interface EgressRule {
  readonly pattern: string
  readonly upstreamId: string | null
}

export interface BrokerConfig {
  /** 宿主面绑定地址。留死在回环上：宿主面不校验令牌，不能对外。 */
  readonly host: string
  /** 宿主面端口：给宿主桌面客户端（第二阶段）用。 */
  readonly hostPort: number
  /** 舱面绑定地址。默认是 docker 网桥网关，local 后端下会被改成回环。 */
  readonly cellHost: string
  /** 舱面端口。 */
  readonly cellPort: number
  /** 舱令牌从哪个环境变量读。 */
  readonly cellTokenEnv: string
  /**
   * 是否接受 `/c/<token>/...` 这种把令牌写进路径的形态。
   *
   * 打开是因为真实的 agent 命令行未必能加自定义请求头（`X-Abx-Cell`），
   * 没有它 `abx open` 就只能跑一个不存在的 agent。代价是令牌会出现在 URL 里，
   * 舱内的 agent 有可能会把它写进自己的日志——那本来也是我们自己发出去的令牌，
   * 泄漏它不等于泄漏任何真实凭据，但仍然不如请求头干净。
   */
  readonly allowCellTokenInPath: boolean
  /** 审计流水落盘位置。 */
  readonly auditPath: string
  /** 单次转发的超时。 */
  readonly requestTimeoutMs: number
}

export interface ResourceLimits {
  /** docker `--memory`，例如 `2g`。 */
  readonly memory: string
  /** docker `--pids-limit`。 */
  readonly pids: number
  /** docker `--cpus`。 */
  readonly cpus: number
}

export interface SessionConfig {
  readonly backend: SandboxBackendId
  /** docker 镜像。 */
  readonly image: string
  /** 舱内以哪个用户跑。非 root。 */
  readonly user: string
  /** docker 网络。 */
  readonly network: string
  /** 任务目录挂进舱内后的路径。 */
  readonly workdir: string
  readonly limits: ResourceLimits
  /** `/tmp` 的 tmpfs 大小（MB）；舱内根文件系统只读，可写的地方只有这里和任务目录。 */
  readonly tmpfsSizeMb: number
}

export type SandboxBackendId = 'docker' | 'local'

export interface AbxConfig {
  readonly broker: BrokerConfig
  readonly egress: readonly EgressRule[]
  readonly upstreams: readonly Upstream[]
  readonly session: SessionConfig
}

/** 出口白名单命中的判定结果，供 broker 决定放行还是 403。 */
export interface UpstreamIndex {
  /** baseUrl 的 hostname → 上游。直通模式下用它决定注不注凭据。 */
  readonly byHost: ReadonlyMap<string, Upstream>
  readonly byId: ReadonlyMap<string, Upstream>
}
