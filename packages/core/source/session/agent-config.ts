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
 * 三种格式都是手写的：TOML 与 YAML 各只用到「表 + 字符串」这一小块，
 * 为它引一个解析/序列化依赖不值得（依赖选型也跟着 osw 走）。
 * `JSON.stringify` 的输出正好同时是合法的 TOML basic string 与合法的 YAML 双引号标量
 * （JSON 的转义集合是这两者的子集），所以引号这件事交给它。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CELL_HOME,
  findAgent,
  generatedConfigFiles,
  productName,
  type AgentConfigFile,
  type AgentConfigFormat,
  type AgentDefinition,
} from '@abx/contracts'
import type { SandboxConfigFile } from './backend'
import { cellBaseUrlFor } from './env'

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentConfigError'
  }
}

/**
 * provider 的 id：写进 TOML 的表名与 YAML 的 route 名下。
 *
 * 用产品名而不是 `osw`：舱内 agent 看到的这一段是**气闸**，上游是谁对它不可见，
 * 也不该可见（它手里那个 token 就是占位符，真凭据在气闸另一侧）。
 */
const PROVIDER_ID = productName

export interface RenderAgentConfigOptions {
  readonly agentId: string
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
  const agent = findAgent(options.agentId)
  if (agent === null) throw new AgentConfigError(`不认识的 agent：${options.agentId}`)

  const baseUrl = cellBaseUrlFor({
    brokerCellOrigin: options.cellOrigin,
    upstreamId: options.upstreamId ?? agent.upstreamId,
    cellToken: options.cellToken ?? '',
    cellTokenVia: agent.cellTokenVia,
    tokenInPath: options.tokenInPath ?? false,
  })

  const cellHome = options.cellHome ?? DEFAULT_CELL_HOME
  const files = generatedConfigFiles(agent).map((file) => ({
    fileName: fileNameOf(file.path),
    cellPath: expandHome(file.path, cellHome),
    format: file.format,
    content: renderContent(agent, file, baseUrl),
  }))

  return { agentId: agent.id, baseUrl, files }
}

/**
 * agent 在舱内的主目录：`<cellHome>/.claude` 这样一段。
 *
 * 从注册表里那几份**会生成**的配置文件的路径推出来，而不是在代码里写死一张
 * `claude → .claude` 的表：注册表已经是路径的唯一真相，再写一张表就会漂。
 *
 * 这个目录同时也是持久化挂载点（见 `instance.ts`）：把整个 agent 主目录挂进去，
 * 历史才跟着走。所以下面几条都必须拦住——
 *
 *   - 配置文件分散在多个目录：只能挂一个，另一个会静默丢历史，不如直接抛；
 *   - 目录就是舱内 home 本身：那等于把整个 home 变成可写挂载点，挂载面大了一整圈。
 */
export function agentHomePath(agent: AgentDefinition, cellHome: string = DEFAULT_CELL_HOME): string {
  const directories = [
    ...new Set(
      generatedConfigFiles(agent).map((file) => path.posix.dirname(expandHome(file.path, cellHome))),
    ),
  ]

  const directory = directories[0]
  if (directory === undefined) {
    throw new AgentConfigError(`agent ${agent.id} 没有登记任何会生成的配置文件，不知道它的舱内主目录在哪。`)
  }
  if (directories.length > 1) {
    throw new AgentConfigError(
      `agent ${agent.id} 的配置文件分散在多个目录里（${directories.join('、')}）：` +
        `持久化挂载只能挂一个目录，请先把它们收敛到同一个目录下。`,
    )
  }
  if (directory === cellHome || directory === '/' || directory === '.') {
    throw new AgentConfigError(
      `agent ${agent.id} 的配置直接写在舱内 home 根上（${directory}）：` +
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

function renderContent(agent: AgentDefinition, file: AgentConfigFile, baseUrl: string): string {
  switch (agent.id) {
    case 'claude':
      expectFormat(agent, file, 'json')
      return renderClaudeSettings(agent, baseUrl)
    case 'codex':
      expectFormat(agent, file, 'toml')
      return renderCodexConfig(agent, baseUrl)
    case 'dsh':
      expectFormat(agent, file, 'yaml')
      return renderDshSettings(agent, baseUrl)
    default:
      // 新加一个 agent 却忘了写生成器时，这里必须**大声**失败：静默返回空内容
      // 会变成「起了个舱，agent 一声不响地去连了真实供应商」这种最难发现的错。
      throw new AgentConfigError(
        `agent ${agent.id} 还没有配置生成器：往 agent-config.ts 里加一个分支，别让它静默地不配。`,
      )
  }
}

function renderClaudeSettings(agent: AgentDefinition, baseUrl: string): string {
  // 形状照 OSW 注册表的 `fields[].path`：`env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN`。
  // JSON 里写不了注释，所以「这份是生成的、别手改」只能写在这儿：
  // 文件每次起舱被重写，手改的东西活不过一次重启。
  const document = {
    env: {
      [agent.baseUrlEnv]: baseUrl,
      [agent.tokenEnv]: agent.placeholderToken,
    },
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function renderCodexConfig(agent: AgentDefinition, baseUrl: string): string {
  // 形状照 OSW 注册表的 `apply.providerEntry`：`model_providers.<id>` 表项。
  //
  // 不写 `model`（归 OSW），也不写 `env_key`：`env_key` 一旦写了，Codex 会要求那个
  // 环境变量必须存在；舱内发出去的令牌本来就是个占位符，多一层间接没有收益。
  return [
    `# ${productName} 生成，每次起舱重写；只读挂载，手改活不过一次重启。`,
    `# 端点只有这一处；占位符 token 走舱内环境变量 ${agent.tokenEnv}，不落在这份文件里。`,
    `# 换模型在 ${productName} 的另一侧，不在这里。`,
    '',
    `model_provider = ${jsonString(PROVIDER_ID)}`,
    '',
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${jsonString(productName)}`,
    `base_url = ${jsonString(baseUrl)}`,
    `wire_api = ${jsonString('responses')}`,
    '',
  ].join('\n')
}

function renderDshSettings(agent: AgentDefinition, baseUrl: string): string {
  // 形状照 OSW 注册表的 `apply.providerEntry`：`llm-pi-ai.providers.<route>`，
  // `baseURL` 指向服务的 `/v1`，凭证用 `headers.Authorization`（占位符）而不是
  // `apiKeyEnv`——少一层间接，舱内不必再维护一个环境变量。
  //
  // ⚠️ 这一条的字段名**还没对着真实的 ~/.dsh/settings.yaml 核过**（见注册表里 dsh 的
  // status），而且 route 形状里的 `models` 是必填的，这里**故意不写**：那张表是模型清单，
  // 属于模型选择，归 OSW。dsh 因此还转不了 stable。
  return [
    `# ${productName} 生成，每次起舱重写；只读挂载，手改活不过一次重启。`,
    '# 待确认：字段名按 OSW 注册表里的 route 形状写，仍需在真实的 ~/.dsh/settings.yaml 里核对一次。',
    'llm-pi-ai:',
    '  providers:',
    `    ${PROVIDER_ID}:`,
    `      displayName: ${jsonString(productName)}`,
    `      api: ${jsonString('openai-completions')}`,
    `      baseURL: ${jsonString(`${baseUrl}/v1`)}`,
    '      headers:',
    `        Authorization: ${jsonString(`Bearer ${agent.placeholderToken}`)}`,
    '',
  ].join('\n')
}

function expectFormat(agent: AgentDefinition, file: AgentConfigFile, expected: AgentConfigFormat): void {
  if (file.format !== expected) {
    throw new AgentConfigError(
      `agent ${agent.id} 的 ${file.path} 登记成 ${file.format}，生成器只能写 ${expected}：` +
        `两者对不上，改注册表或者改生成器，别让文件内容与声明不一致。`,
    )
  }
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').at(-1) ?? filePath
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2))
  return filePath
}

/**
 * 字符串字面量：`JSON.stringify` 的输出同时是合法的 TOML basic string 与合法的
 * YAML 双引号标量，所以 TOML 与 YAML 两条路都用它，不额外引序列化库。
 */
function jsonString(value: string): string {
  return JSON.stringify(value)
}
