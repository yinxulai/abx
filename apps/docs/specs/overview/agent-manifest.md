# Agent 清单（manifest）

> 一句话：**一个 agent = 一条清单**。加一个 agent 只加数据，不加代码。

这份文档定死「一个 agent 到底由什么构成」。字段的形状以
`packages/contracts/source/agents.ts` 为准；本文解释每个字段为什么是这个形状，
以及哪些地方刻意偏离了最初的设想。

## 一、这句话靠什么成立

`AGENT_DEFINITIONS` 的注释里写着「新增一个 agent 只需要加一条」。在清单重构之前，
这句话有两处是假的：

| 承诺 | 当时的不符 | 现在由什么兜住 |
|---|---|---|
| 加一条就能加一个 agent | 配置**内容**是 `core/session/agent-config.ts` 里的代码写的（按 format 分支的三套渲染器） | 内容是清单里的 `template`，渲染器只做变量替换 |
| 清单管住 agent 的性质 | **镜像不在清单里**，是全局的 `session.image`；三个 agent 共用 `node:22-slim`，而里面没有 `claude` 命令 | 每个 agent 带自己的 `image`，`session.image` 降为可选的覆盖 |

承诺不靠注释维持：`agentManifestProblems()` 是判据，`pnpm lint` 与单测跑同一个函数
（见 §四）。

## 二、清单字段（四组）

### 第 0 组：展示 —— 给人看的身份

```ts
id: string            // 稳定标识，进审计、进目录名、进令牌绑定
label: string         // 给人看的名字，例如 "Claude Code"
icon?: AgentIcon      // { slug: string; color?: string }，可选
```

- `icon` **可选**：没有自定义图标的 agent 什么都不用写，界面回退到字母块
  （`label` 的第一个字）。「加一条数据」对功能面因此仍然成立，不必先准备资产。
- `slug` 是稳定标识（图形资产、CSS / 测试的锚点），`color` 是品牌色；两者都只是
  **描述**，不是图形本身。
- **候选方案是「仓库内相对路径（SVG）」**，本实现没有采用：把 SVG 源码或资产路径
  塞进 contracts，等于让一个只描述形状的包背上一堆会腐烂的图形；面板与托盘也可能
  各自需要不同的画法。图形是界面层的资产，清单只给身份与颜色。
- 已落地的形态有三种：`{slug, color}`（claude）、只有 `{slug}`（codex）、
  整个没有（dsh）。三种都合法，面板与托盘都不许假设 `icon` 一定存在。

### 第 1 组：持久化目录 —— 让历史活过容器

```ts
statePaths: readonly {
  path: string        // 相对**舱内 home** 的路径，例如 '~/.claude'
  mode: 'rw'          // 目前只允许 rw；没有 ro 的用例
}[]
```

- 语义：这一条声明「这个 agent 把历史/状态写在哪」。abx 据此把它挂到一个**按实例
  持久化**的宿主目录上：整目录、可写。
- **整目录挂，不列子路径**：目录结构是 agent 自己的实现细节，会随版本漂移。
  列子路径等于一份会过期的清单，漏一个的后果是那部分历史**静默消失**。
  宿主侧布局与安全边界见 `persistence.md`。
- **必须写在清单里**，不能写在渲染器或挂载策略里：路径是某个 agent 的性质，
  写在代码里的那份表没人会记得跟着 agent 升级一起改。
- 今天每条清单**恰好一个**目录。形状仍是数组，因为语义是「这个 agent 的状态目录」，
  不是「那个唯一的目录」；但挂载策略目前只挂一个，所以 `agentManifestProblems()`
  拒绝多于一个，而不是静默只挂第一个。
- **空数组会被 lint 拒绝**。原规格希望「空 statePaths 的 agent 不挂任何东西、
  也不能崩」；实现里 `planInstance()` 的 `cellPath` 是必填的（历史落点是每条清单
  的核心语义），没有「没有 home」这种形态，所以选择**早失败**：lint 当场说清
  「要么写一个目录，要么先改挂载策略与实例布局」。今天三个 agent 都有历史目录，
  这条约束没有牺牲任何真实用例。
- `agentHomePath()` 负责用 `session.cellHome` 展开 `~`，并拦住「目录就是舱内 home
  本身」这种写法；`agentHomeDirNames()` 从这张表现算出 `.claude` / `.codex` / `.dsh`，
  供挂载策略拦「实例根落在 agent 主目录里」。

### 第 2 组：镜像 —— 拿什么起服务

```ts
image: {
  repository: string   // 例如 'abx-agent-claude'
  version: string      // 钉住的版本，例如 '2.1.308'；不许写 'latest'
}
command: string        // 舱内可执行名，例如 'claude'
args: readonly string[]
```

- **镜像按 agent 给，不共用**。三个 agent 的供应链、版本、启动约束各不相同，
  合成一个「什么都有」的镜像等于把三家的依赖树叠在一起。共用一个全局镜像的后果
  是具体的：`command: 'claude'` 在一个没装 claude 的镜像里起不来，而会话看起来
  是起来了。
- **版本写在这里，不写在构建脚本里**：`repository:version` 就是 docker 认的那个
  引用，也是构建脚本打出来的标签。构建脚本、e2e 都经 `lib/agent-registry.mjs`
  从这里读，脚本里不再出现镜像名字面量。
- **不许 `latest`**：某天顺手拉上来一个新版本，表现是「昨天还能跑、今天行为变了」，
  而没有任何一处改动能解释它。还没有镜像的 agent 写 `AGENT_IMAGE_UNBUILT`
  （`'unbuilt'`），而不是编一个版本号——codex / dsh 目前就是这个状态。
- **`session.image` 现在是可选的覆盖口，不再是全局默认值**。不写就用所选 agent
  的 `image`；写了就以配置为准。它保留的唯一用途是「跑一个跟 agent 无关的裸容器
  做验证」。原来的「全局兜底默认」说法正好反了：默认值住在清单里，配置只是覆盖。
- 没有 `digest` 字段：本地构建出来的镜像没有 RepoDigests，钉 digest 要等镜像推到
  registry 之后才有意义。到那时再加，而不是先留一个没人填的字段。
- 没有 `entrypoint` 覆盖：启动命令由 abx 按 `command` / `args` 拼，镜像里刻意不设
  `ENTRYPOINT` / `CMD`。清单里再放一个 entrypoint 等于给「到底跑什么」留第二个答案。
- `repository` 目前是 `abx-agent-<id>`（本地标签 `:local` 与 `:version` 都是它）。
  registry 前缀（`ghcr.io/...`）尚未拍板；定了只换前缀，字段形状不变。

### 第 3 组：配置模板 —— 把 abx 的接线渲染进去

```ts
configFiles: readonly {
  path: string                       // 相对**舱内 home**，例如 '~/.claude/settings.json'
  format: 'json' | 'toml' | 'yaml'
  generated: boolean                 // abx 会不会为它生成内容
  template?: string                  // 生成时的**内容模板**
  note: string
}[]
```

- **只列文件，绝不列目录。** 这些文件与凭据文件是同目录邻居
  （`~/.claude/.credentials.json`、`~/.codex/auth.json`）。「把配置目录挂进舱」
  和「把 OAuth 凭据送进舱」是同一个动作，所以挂载单位只能是单个文件。
- `generated: true` 必须有 `template`，`false` 必须没有。只登记不生成的文件
  （dsh 遗留的 `config.yaml`）用来把配置面写全：让人一眼看出「这是配置，但 abx 不碰」。
- 挂载权限**不是字段**：生成的配置永远只读挂进舱，后端那一层没有别的形状。
  加一个 `mount: 'rw'` 只会多出一种没人能用的写法。
- **模板是数据，不是代码。** 渲染器（`core/session/agent-config.ts`）不认识任何
  agent id，连 `switch` 都没有：它凑齐白名单变量的值，交给
  `renderAgentConfigTemplate()` 替换，再把结果落到实例状态目录。加一个 agent 换
  配置形状时，改的是数据。

**变量是白名单，写错就失败**（fail closed）：

| 变量 | 含义 |
|---|---|
| `${productName}` | 产品名（`abx`） |
| `${baseUrl}` | 舱内要访问的完整端点：气闸舱面 + `/u/<upstreamId>`（令牌是否进 URL 已按 `cellTokenVia` 决定） |
| `${baseUrlEnv}` | 这个 agent 认的端点变量名，例如 `ANTHROPIC_BASE_URL` |
| `${tokenEnv}` | 装占位符 token 的变量名，例如 `ANTHROPIC_AUTH_TOKEN` |
| `${placeholderToken}` | 舱内发出去的那个假 token |
| `${cellOrigin}` | 气闸舱面的地址 |
| `${cellToken}` | **本次会话**的舱令牌（一次一换） |
| `${upstreamId}` | 这次会话走的上游 id |

- 模板里出现白名单之外的变量名 → **直接报错，不渲染**。写错一个字母就渲染出一个
  空端点，而且不报错，只有真跑才炸——这是最坏的一种失败。
- **真实凭据永远不在白名单里**：舱内拿到的只有占位符，broker 无条件替换它。
- 原设想里有 `${cellTokenHeader}` / `${cellTokenPathPrefix}` 两个变量，按
  `cellTokenVia` 二选一。实现改成只给 `${baseUrl}`：令牌放哪儿是**一条规则**，
  由 `cellBaseUrlFor()` 按 `cellTokenVia` 算一次；把它写进每份模板，等于让同一套
  分支逻辑在数据里抄很多遍，还会出现「模板选了请求头、清单说走路径」的矛盾。
  需要自己拼端点的 agent 仍然拿得到 `${cellOrigin}` 与 `${cellToken}`。
- **值按目标格式转义**：模板写的是引号内部的内容，值里的引号 / 反斜杠 / 换行先
  转义再放进去。三种格式共用同一条规则——`JSON.stringify` 的输出同时是合法的
  TOML basic string 与合法的 YAML 双引号标量（JSON 的转义集合是那两者的子集）。
  表仍按格式列着，将来真出现转义规则不同的格式时有个显然的地方改。

### 既有组：上游接线（本次不变）

`upstreamId` / `baseUrlEnv` / `tokenEnv` / `placeholderToken` / `extraEnv` /
`cellTokenVia` / `oswClientKey` / `status` / `note`。

## 三、清单的流转

```
contracts/agents.ts     清单（数据，唯一真相）
        │
        ├─→ core/session/agent-config.ts   渲染器：白名单变量 + 模板 → 文件内容
        ├─→ core/session/instance.ts       按 statePaths 算舱内主目录与宿主侧目录
        ├─→ core/session/mount-policy.ts   按 statePaths + configFiles 组挂载清单
        ├─→ core/commands/open.ts          按 image / command / args 起舱
        ├─→ packages/console               按 label / icon 画面板
        └─→ toolkit/scripts                构建与 e2e 经 lib/agent-registry.mjs 读镜像
```

两个后端的差异不在这里：`local` 后端不挂载，所以不生成配置、不建实例目录；
清单对它仍然只起「选命令与镜像」的作用。

## 四、谁在守这些不变量

**判据只有一份：`agentManifestProblems()`**（`packages/contracts/source/agents.ts`）。
它返回问题清单而不是布尔，每一句都说清是哪条 agent 的哪个字段。它检查：

- `id` 是小写字母开头的标识符、不重复；
- `image.repository` 非空、`image.version` 非空且不是 `latest`；
- `statePaths` 非空、每项是 `~/...`、不超过一个；
- `generated` ⇔ 有 `template`；模板变量都在白名单里；生成的配置落在某个
  `statePaths` 里面；
- 有 `icon` 时 `slug` 非空。

两个调用点：`pnpm lint` 里的 `check-agent-manifest.mjs`，以及单测。
`check-agent-manifest.mjs` 另外做两件静态检查，它们守的是「没有第二份真相」：

1. `packages/toolkit/scripts/**` 里不许出现任何 agent 镜像名 —— 构建脚本与 e2e
   必须经 `lib/agent-registry.mjs` 从注册表读；
2. `packages/*/source` 里（除注册表与测试外）没有哪个文件同时列出两个以上 agent id
   —— 那就是第二张 agent 表。扫描前先剥注释，所以文档里举例提到的 agent 名不会误报。

面板只把 `AGENT_DEFINITIONS` 映射成 `{id, label, icon}`，不自己维护列表。

## 五、验收对照

- **假 agent**：`packages/core/source/session/agent-manifest.test.ts` 里有一条只在
  测试中存在的清单，不碰渲染器 / 挂载策略 / 后端的任何代码，走完整条路：
  配置内容、舱内主目录与宿主侧目录、挂载清单（并过挂载策略的闸）、起舱参数
  （镜像 + 命令 + 参数）全部按它产出。这是「清单真的是唯一真相」的判据。
- **模板白名单**：未知变量必须抛 `AgentManifestError`，不许渲染成空值；
  三种格式的转义都有用例。
- **镜像**：每条清单都有自己的镜像，版本非空且不是 `latest`；构建脚本打出来的
  标签与注册表里的 `repository:version` 逐字一致。
- **面板**：三种 icon 形态各有断言，且 `App` 的图标来自注册表而不是界面里的表。
