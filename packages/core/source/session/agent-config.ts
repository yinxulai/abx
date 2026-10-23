/**
 * 生成 agent 配置。
 *
 * 这个文件回答「舱内的 agent 从哪儿知道往哪发请求」，答案刻意只有一句话：
 * **abx 现写一份最小配置，只读挂进去。**
 *
 * 为什么不是挂宿主那份现成的配置（`~/.claude/settings.json`）：
 *
 *   1. 宿主那份里可能已经写着别家的 key、别的端点、别的模型，挂真的等于把它带进舱；
 *   2. 同目录还躺着 `~/.claude/.credentials.json`（账户 OAuth）、`~/.codex/auth.json`
 *      这些凭据文件。**「把配置目录整个挂进去」与「把 OAuth 凭据送进舱」是同一个动作**，
 *      所以挂载单位只能是单个文件，而且只能是这里生成的那一个。
 *
 * 生成出来的内容只有两样东西：**一个 baseUrl**（指向气闸舱面，不是上游供应商）
 * 和**一个占位符 token**（broker 无条件换掉它，不校验它的内容，见 `broker/credentials.ts`）。
 *
 * 故意**不写 `model`**：换模型是 OSW 的事。abx 写死一个模型名，就等于把「谁来选模型」
 * 这件事从 OSW 手里拿走了 —— 而配置里唯一的那个端点本来就通到 OSW。
 *
 * **内容本身不在这个文件里**，它在清单里（`AgentConfigFile.template`）。这一层只做
 * 三件事：把白名单变量的值凑齐、交给模板渲染、把结果落到实例状态目录里。
 * 所以加一个 agent 换个配置形状时，改的是数据，不是这里的代码——渲染器不认识
 * 任何 agent id，它连 `switch` 都没有。
 *
 * 值的转义由 `renderAgentConfigTemplate()` 负责（三种格式共用同一条规则：
 * `JSON.stringify` 的输出同时是合法的 TOML basic string 与合法的 YAML 双引号标量，
 * JSON 的转义集合是那两者的子集），所以这一层不必为格式操心，也不必引序列化依赖。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CELL_HOME,
  MCP_SHIM_CELL_PATH,
  TRANSOM_SERVER_NAME,
  findAgent,
  generatedConfigFiles,
  productName,
  renderAgentConfigTemplate,
  type AgentConfigFile,
  type AgentConfigFormat,
  type AgentDefinition,
} from '@abx/contracts'
import type { SandboxConfigFile } from './backend'
import { cellBasename, cellHomePath } from './cell-path'
import { cellBaseUrlFor } from './env'

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentConfigError'
  }
}

export interface RenderAgentConfigOptions {
  readonly agentId: string
  /**
   * 直接给一条清单，而不是按 `agentId` 去注册表里查。
   *
   * 存在的理由是**证明渲染器与 agent 无关**：用例里加一条假清单就能把整条路走完
   * （配置内容 / 挂载清单 / 起舱参数），一个渲染器代码都不用碰。给了它就必须与
   * `agentId` 指的是同一个 agent，对不上直接抛——两处说得不一样时，静默选一个
   * 只会让「到底渲染了谁」变成一件要读代码才知道的事。
   */
  readonly definition?: AgentDefinition
  /** 气闸舱面的地址，例如 `http://host.docker.internal:8789`。 */
  readonly cellOrigin: string
  /** 走哪个上游。缺省用 agent 注册表里的那个。生产形态下是 `osw`。 */
  readonly upstreamId?: string
  /** 舱令牌。只有「配置允许 + 这个 agent 没有别的投递方式」时才会进 URL。 */
  readonly cellToken?: string
  readonly tokenInPath?: boolean
  /**
   * `~` 展开成哪儿。
   *
   * **是舱内的 home（`session.cellHome`），不是宿主 home。** 这一条曾经写错过：
   * 默认取 `os.homedir()`，于是生成出来的 `cellPath` 是
   * `/home/<宿主用户>/.claude/settings.json`，而舱内 agent 只会去读
   * `$HOME/.claude/settings.json`（= `/home/node/...`）。挂载参数看上去完全正常，
   * 「让 agent 走气闸」这件事实际没生效。
   *
   * 默认值就是舱内的那个 home，所以「忘了传」得到的是对的答案；要传别的
   * （例如镜像换了 uid）时显式传。
   */
  readonly cellHome?: string
}

export interface RenderedAgentConfigFile {
  /** 配置文件名（宿主路径的最后一段），也是落盘时的文件名。 */
  readonly fileName: string
  /** 舱内挂到哪儿。与宿主那份配置的路径**完全一致**（D2），否则 agent 不会去那儿找。 */
  readonly cellPath: string
  readonly format: AgentConfigFormat
  readonly content: string
}

export interface RenderedAgentConfig {
  readonly agentId: string
  /** 内容里那唯一一个 baseUrl。环境变量与配置文件用的是同一个值。 */
  readonly baseUrl: string
  readonly files: readonly RenderedAgentConfigFile[]
}

/** 生成配置内容。纯函数：不碰文件系统，干跑（`--dry-run`）也能用它列清单。 */
export function renderAgentConfig(options: RenderAgentConfigOptions): RenderedAgentConfig {
  const agent = options.definition ?? findAgent(options.agentId)
  if (agent === null) throw new AgentConfigError(`不认识的 agent：${options.agentId}`)
  if (agent.id !== options.agentId) {
    throw new AgentConfigError(
      `给的清单是 ${agent.id}，而 agentId 是 ${options.agentId}：两者必须指同一个 agent。`,
    )
  }

  const upstreamId = options.upstreamId ?? agent.upstreamId
  const cellToken = options.cellToken ?? ''
  const baseUrl = cellBaseUrlFor({
    brokerCellOrigin: options.cellOrigin,
    upstreamId,
    cellToken,
    cellTokenVia: agent.cellTokenVia,
    tokenInPath: options.tokenInPath ?? false,
  })

  // 模板能拿到的**全部**东西。它是一份白名单：模板里写别的名字，渲染就失败
  // （见 `renderAgentConfigTemplate`）。真凭据不在其中，也永远不会在——
  // 舱内拿到的只有那个占位符。
  const values: Readonly<Record<string, string>> = {
    productName,
    baseUrl,
    baseUrlEnv: agent.baseUrlEnv,
    tokenEnv: agent.tokenEnv,
    placeholderToken: agent.placeholderToken,
    cellOrigin: options.cellOrigin,
    cellToken,
    upstreamId,
    mcpServerName: TRANSOM_SERVER_NAME,
    mcpShimPath: MCP_SHIM_CELL_PATH,
  }

  const cellHome = options.cellHome ?? DEFAULT_CELL_HOME
  const files = generatedConfigFiles(agent).map((file) => ({
    fileName: fileNameOf(file.path),
    // 清单里的路径是**舱内**的，所以这一行走 `cellHomePath`（posix），不走宿主的 path。
    // 用宿主 path 的后果见 `cell-path.ts`：Windows 上会拼出 `\home\node\.claude\...`。
    cellPath: cellHomePath(file.path, cellHome),
    format: file.format,
    content: renderContent(agent, file, values),
  }))

  return { agentId: agent.id, baseUrl, files }
}

/**
 * agent 在舱内的主目录：`<cellHome>/.claude` 这样一段。
 *
 * 路径来自清单里的 `statePaths`（「这个 agent 把历史写在哪」），**不在这里算**：
 * 它是某个 agent 的性质，会随 agent 版本漂移，写在代码里的那份没人会记得跟着改。
 * 展开 `~` 是这一层的事，因为只有这里知道舱内 home 是哪个。
 *
 * 这个目录同时也是持久化挂载点（见 `instance.ts`）：把整个 agent 主目录挂进去，
 * 历史才跟着走。所以下面几条都必须拦住——
 *
 *   - 一条清单登记了多个目录：挂载策略今天只挂一个（形状闸门判的是
 *     `<实例根>/<实例 id>/<agentId>` 那一格），多出来的会**静默不挂**，不如直接抛；
 *   - 目录就是舱内 home 本身：那等于把整个 home 变成可写挂载点，挂载面大了一整圈。
 */
export function agentHomePath(agent: AgentDefinition, cellHome: string = DEFAULT_CELL_HOME): string {
  const directories = [...new Set(agent.statePaths.map((statePath) => cellHomePath(statePath.path, cellHome)))]

  const directory = directories[0]
  if (directory === undefined) {
    throw new AgentConfigError(
      `agent ${agent.id} 没有登记任何持久化目录（statePaths），不知道它的舱内主目录在哪。`,
    )
  }
  if (directories.length > 1) {
    throw new AgentConfigError(
      `agent ${agent.id} 登记了多个持久化目录（${directories.join('、')}）：` +
        `挂载策略只能挂一个目录，请先把它们收敛到同一个目录下。`,
    )
  }
  if (directory === cellHome || directory === '/' || directory === '.') {
    throw new AgentConfigError(
      `agent ${agent.id} 的持久化目录就是舱内 home 本身（${directory}）：` +
        `那会把整个 home 变成可写挂载点，请让它住在自己的子目录里。`,
    )
  }

  return directory
}

export interface StagedAgentConfigFile extends RenderedAgentConfigFile {
  /** 宿主上实际写到哪儿：`<实例状态目录>/<文件名>`。 */
  readonly hostPath: string
}

export interface StagedAgentConfig {
  readonly agentId: string
  /** 写进了哪个目录。就是这次会话的实例状态目录。 */
  readonly directory: string
  readonly baseUrl: string
  readonly files: readonly StagedAgentConfigFile[]
}

export interface StageAgentConfigOptions extends RenderAgentConfigOptions {
  /**
   * 写到哪个目录：`<instancesRoot>/<instanceId>/<agentId>`，也就是**实例状态目录**。
   *
   * 由调用方给而不是这一层自己算：那个目录必须先由 `ensureInstanceStateDir()` 建出来、
   * 再过 `assertStateDirPolicy()` 那几道闸，**然后**才能往里写。这一层只负责写。
   */
  readonly directory: string
}

/**
 * 生成并落盘。
 *
 * 落盘位置是**实例状态目录本身**（`<instancesRoot>/<instanceId>/<agentId>/settings.json`），
 * 而不是另一个地方：那个目录整个以 rw 挂进舱（历史要写在里面），而配置文件就长在
 * 它里面，于是它天然落在了「可写挂载**内部**」。
 *
 * 所以起容器时还要在这个文件上再套一层**只读**挂载（见 `mount-policy.ts` 里
 * 「生成的配置挂回实例状态目录内部」那条规则）：docker 的嵌套绑定是「深的目标赢」，
 * 目录整体可写、配置那一格改不动，两件事同时成立。
 *
 * 不把文件权限改成 0444：只读是 `:ro` 挂载参数保证的（见 `docker-backend.ts`），
 * 而改权限会让下一轮重写时把自己锁在外面——报的还是一个跟挂载毫无关系的 EACCES。
 */
export function stageAgentConfig(options: StageAgentConfigOptions): StagedAgentConfig {
  const rendered = renderAgentConfig(options)
  const directory = options.directory
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const files = rendered.files.map((file) => {
    const hostPath = path.join(directory, file.fileName)
    writeFileSync(hostPath, file.content, { encoding: 'utf8' })
    return { ...file, hostPath }
  })

  return { agentId: rendered.agentId, directory, baseUrl: rendered.baseUrl, files }
}

/**
 * 落盘结果 → 后端要的那份形状。
 *
 * 只带路径，不带内容：后端只管把文件挂进去，它没有理由看到配置里写了什么
 * （以后端为边界传内容，等于给「顺手把内容打印到日志」留了个门）。
 */
export function toSandboxConfigFiles(config: StagedAgentConfig): readonly SandboxConfigFile[] {
  return config.files.map((file) => ({ hostPath: file.hostPath, cellPath: file.cellPath }))
}

/**
 * 一份生成配置的内容：**照清单里的模板渲染**，不认识任何 agent。
 *
 * `file.template` 是空的就抛：那说明这条清单标了 `generated` 却没有模板
 * （`agentManifestProblems()` 会先一步拦下它，这里是不经过自检那条路的兜底）。
 * 静默返回空内容是最坏的一种失败——起了个舱，agent 一声不响地去连了真实供应商。
 */
function renderContent(agent: AgentDefinition, file: AgentConfigFile, values: Readonly<Record<string, string>>): string {
  if (file.template === undefined || file.template === '') {
    throw new AgentConfigError(
      `agent ${agent.id} 的 ${file.path} 标了生成却没有模板：内容必须来自清单，渲染器不认 agent 是谁。`,
    )
  }

  try {
    return renderAgentConfigTemplate(file.template, values, file.format)
  } catch (error) {
    throw new AgentConfigError(
      `agent ${agent.id} 的 ${file.path} 渲染失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 清单里那条路径的最后一段，也是落盘时的文件名。
 *
 * 走舱内语义（posix）：它跟 `cellPath` 是同一个路径的两半，两边用了不同的语义就
 * 会对不上——而 `fileNameOf` 的结果要拿去过配置文件名白名单，对不上就是误拒。
 */
function fileNameOf(filePath: string): string {
  return cellBasename(filePath)
}
