/**
 * agent 名字 → 环境变量的映射表。
 *
 * 「可扩展」在这里的具体含义是：新增一个 agent 只需要往 `AGENT_DEFINITIONS` 里加一条，
 * 不需要改 session / cli 的任何一行——它们只认这张表。
 *
 * 表里的 `placeholderToken` 是**故意**写成明文常量的：它不是凭据，是舱内唯一能拿到的
 * 那个假 token。设计上 broker 无条件覆盖这个头、不校验它长什么样（见 broker 的
 * `credentials.ts`），所以它长得多像真的都不影响安全性，只影响日志里好不好认。
 */

/** 配置文件序列化用的格式。生成器按它决定怎么写内容。 */
export type AgentConfigFormat = 'json' | 'toml' | 'yaml'

export interface AgentConfigFile {
  /**
   * 宿主上的路径，保持 `~` 写法（与 OSW 客户端注册表里的写法一致，好对账）。
   * 展开成绝对路径是生成器的事，见 `core/session/agent-config.ts`。
   */
  readonly path: string
  readonly format: AgentConfigFormat
  /**
   * abx 会不会为这个文件生成内容。
   *
   * `false` 表示只登记、不生成也不挂载——用来把配置面写全（哪些文件是「配置」），
   * 免得下一个人以为漏了一个。
   */
  readonly generated: boolean
  readonly note: string
}

export interface AgentDefinition {
  readonly id: string
  /** 给人看的名字。 */
  readonly label: string
  /** 舱内要执行的命令。 */
  readonly command: string
  readonly args: readonly string[]
  /** 这个 agent 默认走哪个上游。必须在配置里存在同名 upstream。 */
  readonly upstreamId: string
  /** 指向 broker 舱面地址的环境变量名，例如 `ANTHROPIC_BASE_URL`。 */
  readonly baseUrlEnv: string
  /** 装占位符 token 的环境变量名，例如 `ANTHROPIC_AUTH_TOKEN`。 */
  readonly tokenEnv: string
  /** 舱内发出去的那个假 token。 */
  readonly placeholderToken: string
  /**
   * 额外注入的环境变量，值支持 `${VAR}` 引用同一批要注入的变量。
   *
   * 存在的理由：真实 agent 未必能自己加自定义请求头，而舱面要求 `X-Abx-Cell`。
   * 有的 agent 提供了「附加请求头」这种环境变量，就在这里把令牌塞进去，
   * 让它走请求头那条路，而不是把令牌写进 URL。
   */
  readonly extraEnv: Readonly<Record<string, string>>
  /**
   * 舱令牌走哪儿进 broker：请求头，还是 URL 路径前缀。
   *
   * 有 `extraEnv` 能塞自定义请求头的 agent 一律用 `header`。理由不是洁癖：
   * 路径前缀会把令牌写进每一次请求的 URL 里，而 URL 是最容易被记进日志、
   * 被 agent 自己打印出来、被上游的 access log 收走的地方。请求头没有这个问题。
   *
   * 只有当 agent 确实没提供「附加请求头」这种手段时，才退回 `path`。
   * 这条选择写进注册表而不是散在 CLI 里，是因为它是**某个 agent 的性质**，
   * 跟配置无关；配置里的 `allowCellTokenInPath` 只决定这条路允不允许走。
   */
  readonly cellTokenVia: 'header' | 'path'
  /**
   * 这个 agent 在 OSW 客户端注册表里的 key（`packages/contracts/source/clients/*`）。
   *
   * 留着它是为了对上「同一个工具的两套名字」：abx 这边叫 `claude` / `dsh`，
   * OSW 那边叫 `claude-code` / `deepseek-harness`。两边谈路径和字段名时，
   * 必须能一眼看出说的是同一个东西。
   */
  readonly oswClientKey: string
  /**
   * 这个 agent 的配置文件，与 OSW 注册表对齐。
   *
   * **只列文件，绝不列目录。** 这些文件与凭据文件是**同目录邻居**：
   * `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.pi/agent/auth.json`。
   * 「把配置目录挂进舱」和「把 OAuth 凭据送进舱」是同一件事，
   * 所以挂载单位只能是**单个文件**，而且只挂 abx 自己生成的那一份。
   */
  readonly configFiles: readonly AgentConfigFile[]
  /** `unconfirmed` 表示这条定义还没跟上游工具核对过，跑之前请自己确认。 */
  readonly status: 'stable' | 'unconfirmed'
  readonly note: string
}

/** 舱内可以读到的通用变量，跟具体 agent 无关。 */
export const ABX_CELL_ID_ENV = 'ABX_CELL_ID'
export const ABX_CELL_TOKEN_ENV = 'ABX_CELL_TOKEN'
export const ABX_BROKER_ORIGIN_ENV = 'ABX_BROKER_ORIGIN'
export const ABX_UPSTREAM_ID_ENV = 'ABX_UPSTREAM_ID'

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: [],
    upstreamId: 'anthropic',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    tokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    placeholderToken: 'abx-placeholder-anthropic',
    // Claude Code 支持用 ANTHROPIC_CUSTOM_HEADERS 追加请求头（多行按 "Name: Value" 写），
    // 于是舱令牌走请求头而不是 URL，舱内日志里不会出现令牌。
    //
    // 第二个头是会话 id。少了它，审计里每条记录的 cellId 都是 `unknown-cell`——
    // 而审计的全部意义就是「哪个会话在什么时候碰了哪个域名」，认不出会话等于白记。
    // 这个头不参与鉴权（它由舱内自报），所以伪造它只是让日志难看，不构成放行。
    extraEnv: {
      ANTHROPIC_CUSTOM_HEADERS: 'X-Abx-Cell: ${ABX_CELL_TOKEN}\nX-Abx-Cell-Id: ${ABX_CELL_ID}',
    },
    cellTokenVia: 'header',
    oswClientKey: 'claude-code',
    configFiles: [
      {
        path: '~/.claude/settings.json',
        format: 'json',
        generated: true,
        note: '主配置：`env` 块里的端点与 token。同目录的 `.credentials.json` 是账户 OAuth 凭据，绝不进舱。',
      },
    ],
    status: 'stable',
    note: 'ANTHROPIC_AUTH_TOKEN 是 Claude Code 认的变量名；占位符会被 broker 无条件换掉。路径与字段名以 OSW 客户端注册表为准：`~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN`。',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    args: [],
    upstreamId: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    tokenEnv: 'OPENAI_API_KEY',
    placeholderToken: 'abx-placeholder-openai',
    extraEnv: {},
    cellTokenVia: 'path',
    oswClientKey: 'codex',
    configFiles: [
      {
        path: '~/.codex/config.toml',
        format: 'toml',
        generated: true,
        note: '主配置：`model_provider` 指到 `model_providers.<id>` 表项（`base_url` / `wire_api`）。同目录的 `auth.json` 是登录凭据，绝不进舱。',
      },
    ],
    status: 'stable',
    note: 'OPENAI_BASE_URL 只改 API 端点；Codex 的登录态走的是另一套（`~/.codex/config.toml`，路径与字段名以 OSW 客户端注册表为准），尚未实测。',
  },
  {
    id: 'dsh',
    label: 'dsh',
    command: 'dsh',
    args: [],
    upstreamId: 'dsh',
    baseUrlEnv: 'DSH_BASE_URL',
    tokenEnv: 'DSH_API_KEY',
    placeholderToken: 'abx-placeholder-dsh',
    extraEnv: {},
    cellTokenVia: 'path',
    oswClientKey: 'deepseek-harness',
    configFiles: [
      {
        path: '~/.dsh/settings.yaml',
        format: 'yaml',
        generated: true,
        note: '运行期设置（harness 会热加载）：手写的 provider route 在 `llm-pi-ai.providers.<id>`。',
      },
      {
        path: '~/.dsh/config.yaml',
        format: 'yaml',
        generated: false,
        note: '历史遗留的整机补丁层（一串 `{ id, config }`），已被 profile 补丁层取代。登记它只为把配置面写全：abx 不写它，也不挂它。',
      },
    ],
    status: 'unconfirmed',
    // 这一条还是占位：命令名与配置字段名都没有权威来源，`abx open dsh` 会照跑，
    // 但 doctor 和 open 都会把这条提示打出来。
    note: '待确认：dsh 的命令名尚未核实。生成进 ~/.dsh/settings.yaml 的那份配置按 OSW 注册表里的 route 形状写，字段名（displayName / api / baseURL / headers）还需在真实的 ~/.dsh/settings.yaml 里核对一次才能转 stable。',
  },
]

export function findAgent(id: string): AgentDefinition | null {
  return AGENT_DEFINITIONS.find((agent) => agent.id === id) ?? null
}

export function agentIds(): readonly string[] {
  return AGENT_DEFINITIONS.map((agent) => agent.id)
}

/** 这条定义里 abx 要自己生成内容的那些配置文件。 */
export function generatedConfigFiles(agent: AgentDefinition): readonly AgentConfigFile[] {
  return agent.configFiles.filter((file) => file.generated)
}

/**
 * 登记过的配置文件**名字**（不含目录）。
 *
 * 挂载策略拿它做最后一道形状检查：一个挂载源的 basename 不在这张名单里，
 * 它就不是「某一份 agent 配置」——那多半是把目录挂进去了，或者挂了别的东西。
 */
export function agentConfigFileNames(): readonly string[] {
  const names = AGENT_DEFINITIONS.flatMap((agent) =>
    agent.configFiles.map((file) => file.path.split('/').at(-1)).filter((name): name is string => Boolean(name)),
  )
  return [...new Set(names)]
}
