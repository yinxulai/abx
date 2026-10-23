import {
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  type AgentConfigFile,
  type AgentDefinition,
  type AgentImage,
  type AgentStatePath,
} from '@abx/contracts/agents'

/**
 * 页面上出现的 agent 数据：「Agent 一览」那一节，以及首屏托盘面板示意图里的一排。
 * **唯一来源是清单本身**（`packages/contracts/source/agents.ts`），这里只做三件事：
 *
 * 1. 直接读清单里已有的字段（名字、命令、上游、舱内变量、配置文件、核实状态、
 *    镜像、历史目录）。
 * 2. 把清单里的**内部表示**翻成页面语义。今天只有一处：`AGENT_IMAGE_UNBUILT`
 *    是给脚本看的哨兵值，不能原样显示成版本号（见 `AgentRowImage`）。
 * 3. 什么都不缓存：清单改了，页面跟着改。
 *
 * 类型一律从 `@abx/contracts/agents` 引入，这里不再声明「镜像长什么样」。
 * 官网手抄一份形状的下场是它一定会和清单漂移——上一版就因为自己推测了
 * `{ repository, tag }`，在清单补上 `version` 之后整份过期了。
 */

/**
 * 官网上「镜像」那一格要显示的东西。
 *
 * `AGENT_IMAGE_UNBUILT`（`'unbuilt'`）只表示「这个 agent 的镜像还没构建」，
 * 它是**给脚本看的**哨兵值。把它直接拼成 `abx-agent-codex:unbuilt`，读起来会像
 * 「有一个叫 unbuilt 的版本」，把一个内部约定漏到了界面上。所以数据层先把它翻成
 * 状态，页面按状态决定文案：`unbuilt` 显示人话，`built` 才显示 `仓库:版本`。
 */
export type AgentRowImage =
  | ({ readonly state: 'built' } & AgentImage)
  | { readonly state: 'unbuilt'; readonly repository: AgentImage['repository'] }

export type AgentRow = {
  id: string
  label: string
  command: string
  upstreamId: string
  status: AgentDefinition['status']
  baseUrlEnv: string
  tokenEnv: string
  placeholderToken: string
  /** 舱令牌从哪儿进 broker —— 决定了舱内日志里会不会出现令牌。 */
  cellTokenVia: AgentDefinition['cellTokenVia']
  configFiles: readonly AgentConfigFile[]
  /** 这个 agent 把历史、会话、缓存写在哪。 */
  statePaths: readonly string[]
  /** 按 agent 指定的镜像，以及它构建了没有。 */
  image: AgentRowImage
}

export function buildAgentRows(definitions: readonly AgentDefinition[]): readonly AgentRow[] {
  return definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    command: [definition.command, ...definition.args].join(' '),
    upstreamId: definition.upstreamId,
    status: definition.status,
    baseUrlEnv: definition.baseUrlEnv,
    tokenEnv: definition.tokenEnv,
    placeholderToken: definition.placeholderToken,
    cellTokenVia: definition.cellTokenVia,
    configFiles: definition.configFiles,
    statePaths: statePathsOf(definition.statePaths),
    image: imageOf(definition.image),
  }))
}

/** 官网页面上那一份。组件只读它，不自己去翻清单。 */
export const AGENT_ROWS: readonly AgentRow[] = buildAgentRows(AGENT_DEFINITIONS)

/**
 * 托盘面板那一排的 agent：**只放已安装的**（`product/tray-ui.md` §3.1 ④）。
 *
 * 镜像还没构建的 agent 不进托盘。那一排只有图标，而一个图标代表不了一个还没装的 agent：
 * 它既没有可辨认的身份，也没有可执行的动作——那是管理面板要回答的问题，不是托盘的。
 *
 * 判据是清单里的镜像状态，**不是这里手写的一份名单**：镜像建出来那天，它自己会进这一排，
 * 页面上没有一行要改。与 `packages/console` 的托盘是同一个过滤条件。
 */
export function trayAgentRows(definitions: readonly AgentDefinition[]): readonly AgentRow[] {
  return buildAgentRows(definitions).filter(row => row.image.state === 'built')
}

/** 首屏那张面板示意图用的一排。 */
export const TRAY_AGENT_ROWS: readonly AgentRow[] = trayAgentRows(AGENT_DEFINITIONS)

/** 历史目录：清单里直接给的就是舱内路径，页面照原样列出来。 */
function statePathsOf(statePaths: readonly AgentStatePath[]): readonly string[] {
  return statePaths.map(statePath => statePath.path)
}

/** 镜像：先把「还没构建」这个哨兵翻成状态，再交给页面。 */
function imageOf(image: AgentImage): AgentRowImage {
  if (image.version === AGENT_IMAGE_UNBUILT) {
    return { state: 'unbuilt', repository: image.repository }
  }
  return { state: 'built', repository: image.repository, version: image.version }
}
