import { AGENT_DEFINITIONS, type AgentConfigFile, type AgentDefinition } from '@abx/contracts/agents'

/**
 * 官网「Agent 一览」的数据。**唯一来源是清单本身**
 * （`packages/contracts/source/agents.ts`），这里只做三件事：
 *
 * 1. 直接读清单里已有的字段（名字、命令、上游、舱内变量、配置文件、核实状态）。
 * 2. 把清单**还没声明、但官网要说**的两格（镜像、历史目录）按清单推导，
 *    读不到就如实说「清单里没有」，而不是在官网手抄一份。
 * 3. 什么都不缓存：清单改了，页面跟着改。
 *
 * 为什么第 2 条要这么绕：手抄一份的下场是它一定会和清单漂移 —— 而镜像与历史目录
 * 恰恰是**某个 agent 的性质**，会随 agent 版本变（见
 * `apps/docs/specs/overview/agent-manifest.md`）。所以宁可现在这一格显示
 * 「清单里还没指定」，也不要写死一个明天就过期的值。
 */

/** 清单里按 agent 给的容器镜像（`agent-manifest.md` 第 2 组）。 */
export type AgentImage = {
  repository: string
  tag: string
}

/**
 * 清单上还没有、但正在往里搬的字段。
 *
 * 断言成一个可选的附加形状，而不是写死「清单里没有这两个字段」：
 * 清单补上之后，官网**不需要改一行**就开始显示它们。读之前过一遍类型守卫，
 * 所以字段名写错、值不是字符串也都是「读不到」，不会渲染出半个对象。
 */
type PendingManifestFields = {
  image?: AgentImage
  statePaths?: readonly { path: string }[]
}

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
  /** 按 agent 指定的镜像；清单里还没有就是 `null`。 */
  image: AgentImage | null
}

export function buildAgentRows(
  definitions: readonly AgentDefinition[],
): readonly AgentRow[] {
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
    statePaths: statePathsOf(definition),
    image: readImage(definition),
  }))
}

/** 官网页面上那一份。组件只读它，不自己去翻清单。 */
export const AGENT_ROWS: readonly AgentRow[] = buildAgentRows(AGENT_DEFINITIONS)

/**
 * 历史目录：清单声明了就用手册那一份，没声明就从配置文件的位置推。
 *
 * 推导的依据是一个必须成立的约定：**配置文件就在这个 agent 的状态目录里**
 * （`~/.claude/settings.json` 在 `~/.claude` 下）。清单的注释里写着配置文件与凭据
 * 文件是同目录邻居 —— 也就是说，这个目录既是配置目录，也是历史目录。
 * 一旦清单声明了 `statePaths`，推导让位，以声明为准。
 */
function statePathsOf(definition: AgentDefinition): readonly string[] {
  const declared = (definition as AgentDefinition & PendingManifestFields).statePaths
  if (Array.isArray(declared)) {
    return declared.map(entry => entry.path)
  }

  const directories = definition.configFiles
    .map(file => parentDirectory(file.path))
    .filter((directory): directory is string => directory !== null)

  return [...new Set(directories)]
}

/** `~/.claude/settings.json` → `~/.claude`；没有父目录（`settings.json`）时是 `null`。 */
function parentDirectory(filePath: string): string | null {
  const separator = filePath.lastIndexOf('/')
  return separator <= 0 ? null : filePath.slice(0, separator)
}

function readImage(definition: AgentDefinition): AgentImage | null {
  const image = (definition as AgentDefinition & PendingManifestFields).image
  if (typeof image !== 'object' || image === null) return null
  if (typeof image.repository !== 'string' || typeof image.tag !== 'string') return null
  return { repository: image.repository, tag: image.tag }
}
