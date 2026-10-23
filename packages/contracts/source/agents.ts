/**
 * agent 清单：**一个 agent = 一条数据**。
 *
 * 「可扩展」在这里的具体含义是：新增一个 agent 只需要往 `AGENT_DEFINITIONS` 里加一条，
 * 不需要改 session / cli / 渲染器 / 面板的任何一行——它们只认这份清单。
 * 这条承诺**不是靠注释维持的**：`agentManifestProblems()` 是它的判据，
 * 由 `packages/toolkit/scripts/check-agent-manifest.mjs` 在 `pnpm lint` 里跑一遍，
 * 单测里再跑一遍（谁也不许在脚本里另写一份镜像名、另抄一张 agent 表）。
 *
 * 一条清单由四组数据构成（展开的规格见 apps/docs/specs/overview/agent-manifest.md）：
 *
 *   0. 展示：`id` / `label` / `icon`
 *   1. 持久化目录：`statePaths` —— 舱内哪些路径必须活过容器销毁
 *   2. 镜像：`image` + `command` / `args` —— 拿什么起服务
 *   3. 配置：`configFiles`（含 `template`）—— abx 往里写什么
 *
 * 表里的 `placeholderToken` 是**故意**写成明文常量的：它不是凭据，是舱内唯一能拿到的
 * 那个假 token。设计上 broker 无条件覆盖这个头、不校验它长什么样（见 broker 的
 * `credentials.ts`），所以它长得多像真的都不影响安全性，只影响日志里好不好认。
 */

/** 配置文件序列化用的格式。决定模板里的值按哪套字面量规则转义。 */
export type AgentConfigFormat = 'json' | 'toml' | 'yaml'

/**
 * 展示用的图标。
 *
 * 这里只有**标识与颜色**，没有图形本身：图形是资产，属于界面层
 * （`packages/console`）。往 contracts 里塞 SVG 源码等于让一个「只描述形状」的包
 * 背上一堆会腐烂的图形，而面板与托盘本来就可以各自决定怎么画。
 *
 * **可选**：没有自定义图标的 agent 什么都不用写，界面回退到字母块
 * （`label` 的第一个字）。所以「加一个 agent 只加一条数据」对功能面仍然成立。
 */
export interface AgentIcon {
  /** 稳定标识，例如 `claude`。界面拿它去找图形资产、也拿它当 CSS / 测试的锚点。 */
  readonly slug: string
  /** 品牌色。不写就用界面自己的中性色。 */
  readonly color?: string
}

/**
 * 一个**必须活过容器销毁**的目录。
 *
 * 语义是「这个 agent 把历史/状态写在这儿」，abx 据此把它挂到一个按实例持久化的
 * 宿主目录上。整目录挂、不列子路径：目录结构是 agent 自己的实现细节，而且会随版本
 * 漂移（claude 换过目录布局），列子路径等于一份会过期的清单，漏一个的后果是
 * **那部分历史静默消失**——比不持久化更坏，因为用户以为它在。
 * 展开的理由与宿主侧布局见 apps/docs/specs/overview/persistence.md。
 */
export interface AgentStatePath {
  /** 相对**舱内 home** 的路径，例如 `~/.claude`。写 `~` 形式，绝对路径会被清单自检拒掉。 */
  readonly path: string
  /**
   * 挂载权限，目前只有 `rw`。
   *
   * 没有 `ro` 的用例：只读的话目录挂上了、历史一行都写不下来，而命令行里看不出
   * 任何异常。真需要只读挂载时再加，届时挂载策略那几道闸也要跟着改。
   */
  readonly mode: 'rw'
}

/** 还没有构建出镜像时，`AgentImage.version` 该写的值。 */
export const AGENT_IMAGE_UNBUILT = 'unbuilt'

/**
 * 这个 agent 的镜像：`repository:version` 就是 docker 认的那个引用。
 *
 * 镜像**按 agent 给**，不共用：三个 agent 的供应链、版本、启动约束各不相同，
 * 合成一个「什么都有」的镜像等于把三家的依赖树叠在一起。共用一个全局镜像的
 * 后果是具体的——`command: 'claude'` 在一个没有装 claude 的镜像里起不来，
 * 而会话看起来「起来了」，其实什么都干不了。
 */
export interface AgentImage {
  /** 镜像仓库名，例如 `abx-agent-claude`。 */
  readonly repository: string
  /**
   * 钉住的版本。**版本写在这里，不写在构建脚本里**——「注册表说一个版本、
   * 脚本里是另一个」正是最容易出现的不一致。构建脚本从这里读，`repository:version`
   * 就是打出来的标签。
   *
   * 不许写 `latest`：某天顺手拉上来一个新版本，表现是「昨天还能跑、今天行为变了」，
   * 而没有任何一处改动能解释它。还没有镜像的 agent 写 `AGENT_IMAGE_UNBUILT`。
   */
  readonly version: string
}

/** 生成配置文件时能拿到的变量，**白名单**。 */
export const AGENT_CONFIG_TEMPLATE_VARIABLES: readonly string[] = [
  /** 产品名（`abx`）。 */
  'productName',
  /** 舱内要访问的端点：气闸舱面 + `/u/<upstreamId>`。 */
  'baseUrl',
  /** 这个 agent 认的端点变量名，例如 `ANTHROPIC_BASE_URL`。 */
  'baseUrlEnv',
  /** 装占位符 token 的变量名，例如 `ANTHROPIC_AUTH_TOKEN`。 */
  'tokenEnv',
  /** 舱内发出去的那个假 token。 */
  'placeholderToken',
  /** 气闸舱面的地址。 */
  'cellOrigin',
  /** **本次会话**的舱令牌（一次一换）。 */
  'cellToken',
  /** 这次会话走的上游 id。 */
  'upstreamId',
]

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
  /**
   * 生成内容的**模板**。`generated: true` 时必须写，`false` 时不许写。
   *
   * 模板就是文件内容的全文（引号也写出来），其中只有 `${变量}` 会被替换，
   * 变量名必须在 `AGENT_CONFIG_TEMPLATE_VARIABLES` 白名单里：
   *
   *   - 白名单之外的变量名 → **直接报错，不渲染**。写错一个字母就渲染出一个空端点、
   *     而且不报错，只有真跑才炸，这是最坏的一种失败；
   *   - 替换进去的值按文件格式转义（见 `renderAgentConfigTemplate`），
   *     所以模板作者不必操心值里有没有引号。
   *
   * 内容写成**数据**而不是代码，是「加一个 agent 只加一条清单」的关键一步：
   * 渲染器于是与 agent 无关，它只做替换。
   */
  readonly template?: string
  readonly note: string
}

export interface AgentDefinition {
  readonly id: string
  /** 给人看的名字。 */
  readonly label: string
  /** 展示用的图标。可选，缺了就由界面回退到字母块。 */
  readonly icon?: AgentIcon
  /**
   * 这个 agent 在舱内哪些路径必须活过容器销毁。
   *
   * 必须写在清单里，不能写在渲染器或挂载策略里：路径是**某个 agent 的性质**，
   * 会随 agent 版本漂移，写在代码里的那份表没人会记得跟着升级一起改。
   */
  readonly statePaths: readonly AgentStatePath[]
  /**
   * 拿什么起服务：镜像 + 舱内命令。
   *
   * 镜像必须按 agent 给；配置里的 `session.image` 只作兜底默认（不写就用这里这个），
   * 见 `packages/core/source/commands/open.ts`。
   */
  readonly image: AgentImage
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
    icon: { slug: 'claude', color: '#d97757' },
    statePaths: [{ path: '~/.claude', mode: 'rw' }],
    // 本地构建出来的那份镜像，见 images/agents/claude/ 与 build-agent-image.sh。
    // 版本与 Dockerfile 里钉的 CLI 版本是同一个值：镜像里装的 claude 就是它。
    image: { repository: 'abx-agent-claude', version: '2.1.308' },
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
        template: [
          '{',
          '  "env": {',
          '    "${baseUrlEnv}": "${baseUrl}",',
          '    "${tokenEnv}": "${placeholderToken}"',
          '  }',
          '}',
          '',
        ].join('\n'),
        note: '主配置：`env` 块里的端点与 token。同目录的 `.credentials.json` 是账户 OAuth 凭据，绝不进舱。',
      },
    ],
    status: 'stable',
    note: 'ANTHROPIC_AUTH_TOKEN 是 Claude Code 认的变量名；占位符会被 broker 无条件换掉。路径与字段名以 OSW 客户端注册表为准：`~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN`。',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    // 只给标识、不给颜色：颜色是可选的，界面对没有颜色的图标用中性色。
    icon: { slug: 'codex' },
    statePaths: [{ path: '~/.codex', mode: 'rw' }],
    // 镜像**还没建**（`images/agents/codex/` 还不存在），所以版本写 `unbuilt` 而不是
    // 编一个版本号。它同样不是 `latest`：编一个号会让人以为这个镜像存在。
    // 镜像建出来之前 `abx open codex` 会当场失败（docker 找不到镜像）——
    // 这比今天「起一个没有 codex 命令的空壳、看起来还挺正常」要好。
    image: { repository: 'abx-agent-codex', version: AGENT_IMAGE_UNBUILT },
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
        template: [
          '# ${productName} 生成，每次起舱重写；只读挂载，手改活不过一次重启。',
          '# 端点只有这一处；占位符 token 走舱内环境变量 ${tokenEnv}，不落在这份文件里。',
          '# 换模型在 ${productName} 的另一侧，不在这里。',
          '',
          'model_provider = "${productName}"',
          '',
          '[model_providers.${productName}]',
          'name = "${productName}"',
          'base_url = "${baseUrl}"',
          'wire_api = "responses"',
          '',
        ].join('\n'),
        note: '主配置：`model_provider` 指到 `model_providers.<id>` 表项（`base_url` / `wire_api`）。同目录的 `auth.json` 是登录凭据，绝不进舱。',
      },
    ],
    status: 'stable',
    note: 'OPENAI_BASE_URL 只改 API 端点；Codex 的登录态走的是另一套（`~/.codex/config.toml`，路径与字段名以 OSW 客户端注册表为准），尚未实测。镜像也还没建（`image.version` 是 `unbuilt`）。',
  },
  {
    id: 'dsh',
    label: 'dsh',
    // 没有 `icon`：这个 agent 不想要自定义图标，于是清单里什么都不用加，
    // 面板回退到字母块。这一条同时是不变量「icon 可选」的活样例。
    statePaths: [{ path: '~/.dsh', mode: 'rw' }],
    image: { repository: 'abx-agent-dsh', version: AGENT_IMAGE_UNBUILT },
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
        template: [
          '# ${productName} 生成，每次起舱重写；只读挂载，手改活不过一次重启。',
          '# 待确认：字段名按 OSW 注册表里的 route 形状写，仍需在真实的 ~/.dsh/settings.yaml 里核对一次。',
          'llm-pi-ai:',
          '  providers:',
          '    ${productName}:',
          '      displayName: "${productName}"',
          '      api: "openai-completions"',
          '      baseURL: "${baseUrl}/v1"',
          '      headers:',
          '        Authorization: "Bearer ${placeholderToken}"',
          '',
        ].join('\n'),
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
    note: '待确认：dsh 的命令名尚未核实。生成进 ~/.dsh/settings.yaml 的那份配置按 OSW 注册表里的 route 形状写，字段名（displayName / api / baseURL / headers）还需在真实的 ~/.dsh/settings.yaml 里核对一次才能转 stable。镜像也还没建（`image.version` 是 `unbuilt`）。',
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

/** 这个 agent 的镜像引用：`repository:version`。 */
export function agentImageRef(agent: AgentDefinition): string {
  return `${agent.image.repository}:${agent.image.version}`
}

/**
 * 这些 agent 在**宿主**主目录下的目录名（`~/.claude` → `.claude`）。
 *
 * 挂载策略拿它拦「实例根落在 agent 主目录里」：`~/.claude/instances` 这种写法
 * 会让可写挂载源的来源落在一个装着凭据的目录里，而它看起来只是一个路径。
 * 从清单里现算而不是在策略里再抄一份——抄的那份不会跟着新 agent 长。
 */
export function agentHomeDirNames(definitions: readonly AgentDefinition[] = AGENT_DEFINITIONS): readonly string[] {
  const names = definitions.flatMap((agent) =>
    agent.statePaths
      .map((statePath) => statePath.path.split('/')[1])
      .filter((segment): segment is string => segment !== undefined && segment !== ''),
  )
  return [...new Set(names)]
}

/** 模板里出现的变量名（按出现顺序，含重复）。 */
export function templateVariableNames(template: string): readonly string[] {
  return [...template.matchAll(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] ?? '')
}

export class AgentManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentManifestError'
  }
}

/**
 * 渲染模板：把 `${变量}` 换成值。
 *
 * 两件事都必须做对，两件都不是「顺手加个功能」：
 *
 *   1. **白名单之外的名字直接抛**，不渲染成空串。写错一个字母就渲染出一个空端点，
 *      而且不报错——只有真跑才炸，那时表现是「agent 连不上」，跟「闸没配好」长得一样。
 *   2. **值按目标格式转义**。模板写的是引号内部的字面量，值里的引号/反斜杠/换行
 *      必须先转义，否则一个配置里写错的值就能把整份文件的结构撑破。
 */
export function renderAgentConfigTemplate(template: string, values: Readonly<Record<string, string>>, format: AgentConfigFormat): string {
  const escape = TEMPLATE_ESCAPERS[format]
  if (escape === undefined) {
    throw new AgentManifestError(`不认识的配置格式：${JSON.stringify(format)}，不知道怎么转义模板里的值。`)
  }

  return template.replaceAll(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name: string) => {
    const value = values[name]
    if (value === undefined) {
      throw new AgentManifestError(
        `模板里出现了未知变量 ${match}：可用的是 ${AGENT_CONFIG_TEMPLATE_VARIABLES.join(' / ')}。` +
          `渲染器只替换白名单里的变量，写错名字就直接失败——渲染成空值只会让配置里多一个空端点。`,
      )
    }
    return escape(value)
  })
}

/**
 * 字符串字面量**内部**的转义（模板里把引号写出来了，这里换的是引号里面那一段）。
 *
 * 三种格式共用同一个实现，这是有依据的而不是偷懒：`JSON.stringify` 的输出同时是
 * 合法的 TOML basic string 与合法的 YAML 双引号标量——JSON 的转义集合是那两者的子集。
 * 表按格式列出来，是为了将来真的加一种转义规则不同的格式时，有个显然的地方去改，
 * 而不是让它悄悄落到一个默认分支上。
 */
const TEMPLATE_ESCAPERS: Readonly<Record<AgentConfigFormat, (value: string) => string>> = {
  json: jsonStringInterior,
  toml: jsonStringInterior,
  yaml: jsonStringInterior,
}

function jsonStringInterior(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * 清单自检：这条清单自不自洽。
 *
 * 返回的是**问题清单**（空数组 = 没问题），不是布尔：报错要说清是哪一条 agent 的
 * 哪个字段，否则「清单里有一处不对」这句话没法照着改。
 *
 * 它有两个调用点，**判据只有这一份**：`pnpm lint` 里的
 * `check-agent-manifest.mjs`（不用跑测试就能拦住），以及单测。
 */
export function agentManifestProblems(definitions: readonly AgentDefinition[] = AGENT_DEFINITIONS): readonly string[] {
  const problems: string[] = []
  const report = (agent: AgentDefinition, message: string): void => {
    problems.push(`${agent.id}：${message}`)
  }

  for (const agent of definitions) {
    if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) {
      report(agent, `id ${JSON.stringify(agent.id)} 不是小写字母开头的标识符（它要进目录名、审计和容器名）。`)
    }
    if (definitions.filter((candidate) => candidate.id === agent.id).length > 1) {
      report(agent, 'id 重复。')
    }

    // 镜像：必须按 agent 给，版本必须是钉住的那个（不是 latest、不是空串）。
    if (agent.image.repository.trim() === '') report(agent, 'image.repository 是空的。')
    if (agent.image.version.trim() === '') {
      report(agent, 'image.version 是空的：没有镜像就写 AGENT_IMAGE_UNBUILT，不要留空。')
    } else if (agent.image.version === 'latest') {
      report(agent, 'image.version 是 latest：版本必须钉住，否则镜像内容会在某天悄悄变。')
    }

    // 持久化目录：至少一个，都写成 `~/...`，且不能是舱内 home 本身。
    if (agent.statePaths.length === 0) {
      report(agent, 'statePaths 是空的：至少要有历史落点，或者明确不持久化这件事本身要写成数据。')
    }
    if (agent.statePaths.length > 1) {
      report(
        agent,
        `statePaths 登记了 ${agent.statePaths.length} 个目录，而挂载策略今天只挂一个` +
          `（形状闸门判的是 <实例根>/<实例 id>/<agentId> 那一格）：多出来的会静默不挂。` +
          `要支持多个，先改 mount-policy.ts 的闸门与宿主侧布局。`,
      )
    }
    for (const statePath of agent.statePaths) {
      if (!statePath.path.startsWith('~/') || statePath.path.slice(2).trim() === '') {
        report(agent, `statePaths 里的 ${JSON.stringify(statePath.path)} 必须是 ~/... 形式（相对舱内 home）。`)
      }
    }

    // 配置：生成的必须有模板，不生成的必须没有；模板里的变量必须在白名单里；
    // 生成的配置必须落在某个持久化目录里面。
    for (const file of agent.configFiles) {
      if (file.generated && (file.template === undefined || file.template === '')) {
        report(agent, `${file.path} 标了 generated 却没有 template：渲染器与 agent 无关，内容必须来自清单。`)
      }
      if (!file.generated && file.template !== undefined) {
        report(agent, `${file.path} 没有 generated 却有 template：不生成的文件不会有人渲染它，模板只会误导下一个人。`)
      }
      if (file.template === undefined) continue

      for (const name of templateVariableNames(file.template)) {
        if (!AGENT_CONFIG_TEMPLATE_VARIABLES.includes(name)) {
          report(
            agent,
            `${file.path} 的模板里出现了白名单之外的变量 \${${name}}：` +
              `可用的是 ${AGENT_CONFIG_TEMPLATE_VARIABLES.join(' / ')}。真实凭据永远不进模板。`,
          )
        }
      }

      const directory = file.path.split('/').slice(0, -1).join('/')
      const inside = agent.statePaths.some(
        (statePath) => directory === statePath.path || directory.startsWith(`${statePath.path}/`),
      )
      if (!inside) {
        report(
          agent,
          `${file.path} 不在任何 statePaths 里面（${agent.statePaths.map((statePath) => statePath.path).join('、')}）：` +
            `配置文件要么落进持久化目录、跟着它一起挂进舱，要么就没人会去读它。`,
        )
      }
    }

    if (agent.icon !== undefined && agent.icon.slug.trim() === '') {
      report(agent, 'icon.slug 是空的：要么给一个稳定标识，要么整个 icon 都别写。')
    }
  }

  return problems
}
