/**
 * 使用手册里的 agent 数据。
 *
 * **不在这里手抄一份清单。** 名字、命令、配置落点、上游、状态、镜像与历史目录
 * 全部取自 `@abx/contracts/agents`（清单是唯一真相）。MDX 页面只负责排版，
 * 不负责记住这些字符串——清单改了，文档跟着变。
 *
 * 镜像**按 agent 给**：每条清单带自己的 `image.repository` + `image.version`，
 * 起舱用的是所选 agent 的那一条。配置里的 `session.image` 只是可选的覆盖口，
 * 没有全局默认值，所以这里也没有「兜底镜像」可以抄。
 *
 * 这份模块也被 `source/docs.test.ts` 拿去断言「页面里出现的每个 agent 都在清单里」，
 * 所以它同时是文档与代码之间的那条线。
 */
import {
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  agentImageRef,
  type AgentConfigFile,
  type AgentStatePath,
} from '@abx/contracts/agents'

export interface AgentConfigFileDoc {
  readonly path: string
  readonly format: AgentConfigFile['format']
  readonly generated: boolean
  readonly note: string
}

export interface AgentImageDoc {
  readonly repository: string
  readonly version: string
  /** `repository:version`，就是 docker 认的那个引用。 */
  readonly reference: string
  /**
   * 镜像是否已经构建出来。
   *
   * `version === AGENT_IMAGE_UNBUILT` 表示清单登记了仓库名、但镜像还没建。
   * 页面必须把这种情况写成「尚未构建」，而不是「尚未指定」：前者是「还没做」，
   * 后者会让人以为清单漏了数据。
   */
  readonly built: boolean
}

export interface AgentDoc {
  readonly id: string
  readonly label: string
  /** 完整的舱内命令，例如 `claude`。 */
  readonly command: string
  readonly upstreamId: string
  readonly baseUrlEnv: string
  readonly tokenEnv: string
  /** 舱令牌走请求头还是 URL 路径。 */
  readonly cellTokenVia: 'header' | 'path'
  /** 对得上 OSW 客户端注册表里的 key。 */
  readonly oswClientKey: string
  readonly status: 'stable' | 'unconfirmed'
  readonly note: string
  /** abx 会生成内容的配置文件。 */
  readonly generatedFiles: readonly AgentConfigFileDoc[]
  /** 清单登记过的全部配置文件（含 `generated: false` 的只登记项）。 */
  readonly registeredFiles: readonly AgentConfigFileDoc[]
  /** 这个 agent 自己的镜像。没有「全局默认镜像」这回事。 */
  readonly image: AgentImageDoc
  /** 需要跨舱保留的目录（相对舱内 home），abx 按实例挂到宿主上。 */
  readonly statePaths: readonly AgentStatePath[]
}

const toFileDoc = (file: AgentConfigFile): AgentConfigFileDoc => ({
  path: file.path,
  format: file.format,
  generated: file.generated,
  note: file.note,
})

export const AGENT_DOCS: readonly AgentDoc[] = AGENT_DEFINITIONS.map((agent) => ({
  id: agent.id,
  label: agent.label,
  command: [agent.command, ...agent.args].join(' '),
  upstreamId: agent.upstreamId,
  baseUrlEnv: agent.baseUrlEnv,
  tokenEnv: agent.tokenEnv,
  cellTokenVia: agent.cellTokenVia,
  oswClientKey: agent.oswClientKey,
  status: agent.status,
  note: agent.note,
  generatedFiles: agent.configFiles.filter((file) => file.generated).map(toFileDoc),
  registeredFiles: agent.configFiles.map(toFileDoc),
  image: {
    repository: agent.image.repository,
    version: agent.image.version,
    // 引用格式只由清单那一处定义，文档不另拼一份。
    reference: agentImageRef(agent),
    built: agent.image.version !== AGENT_IMAGE_UNBUILT,
  },
  statePaths: agent.statePaths,
}))

/** 清单里登记了镜像、但镜像还没构建的 agent。页面据此说「尚未构建」。 */
export const AGENTS_IMAGE_UNBUILT: readonly string[] = AGENT_DOCS.filter((agent) => !agent.image.built).map(
  (agent) => agent.id,
)

/** 页面上的计数（例如「三个 agent」）也从清单来，不写死。 */
export const AGENT_COUNT: number = AGENT_DOCS.length
