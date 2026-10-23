/**
 * 使用手册里的 agent 数据。
 *
 * **不在这里手抄一份清单。** 名字、命令、配置落点、上游、状态全部取自
 * `@abx/contracts/agents`（清单是唯一真相）；镜像默认值取自配置 schema 的默认值。
 * MDX 页面只负责排版，不负责记住这些字符串——清单改了，文档跟着变。
 *
 * 这份模块也被 `source/docs.test.ts` 拿去断言「页面里出现的每个 agent 都在清单里」，
 * 所以它同时是文档与代码之间的那条线。
 */
import { AGENT_DEFINITIONS, type AgentConfigFile } from '@abx/contracts/agents'
import { abxConfigSchema } from '@abx/contracts/schema'

export interface AgentConfigFileDoc {
  readonly path: string
  readonly format: AgentConfigFile['format']
  readonly generated: boolean
  readonly note: string
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
  /**
   * 这个 agent 自己的镜像。
   *
   * 清单里**还没有**这一项，所以当前是 `null`：起舱时用的是
   * `session.image` 的全局默认值（见 `SESSION_IMAGE_FALLBACK`）。
   * 页面必须如实呈现这一点，不能把全局默认值写成「这个 agent 的镜像」。
   */
  readonly image: string | null
  /**
   * 需要跨舱保留的目录（相对舱内 home）。
   *
   * 清单里同样**还没有**这一项，因此当前一律为空：一次性舱退出后，
   * agent 自己的会话历史不会留下。见 `source/zh/inside/history.mdx`。
   */
  readonly statePaths: readonly string[]
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
  image: null,
  statePaths: [],
}))

/** 起舱时实际使用的镜像（清单没有 per-agent 镜像时的全局兜底）。 */
export const SESSION_IMAGE_FALLBACK: string = abxConfigSchema.parse({}).session.image

/** 清单里是否已经登记了「每个 agent 自己的镜像」。 */
export const IMAGES_DECLARED: boolean = AGENT_DEFINITIONS.every((agent) => 'image' in agent)

/** 清单里是否已经登记了「跨舱保留的目录」。 */
export const STATE_PATHS_DECLARED: boolean = AGENT_DEFINITIONS.every((agent) => 'statePaths' in agent)

/** 页面上的计数（例如「三个 agent」）也从清单来，不写死。 */
export const AGENT_COUNT: number = AGENT_DOCS.length
