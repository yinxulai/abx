# Agent 清单（manifest）

> 一句话：**一个 agent = 一条清单**。加一个 agent 只加数据，不加代码。

## 一、为什么要有这份清单

`packages/contracts/source/agents.ts` 的注释里现在写着：

> 新增一个 agent 只需要往 `AGENT_DEFINITIONS` 里加一条，不需要改 session / cli 的任何一行。

**这句话目前是假的**，两处不符：

| 承诺 | 实际 |
|---|---|
| 加一条就能加一个 agent | 配置**内容**是 `core/session/agent-config.ts` 里的**代码**写的（JSON/TOML/YAML 三套生成逻辑）。新 agent 换个配置形状，就得改渲染器 |
| 清单管住 agent 的性质 | **镜像不在清单里**，是全局的 `session.image`。三个 agent 现在共用 `node:22-slim`，而 `command: 'claude'` 在 `node:22-slim` 里根本不存在 |

所以这份文档把「一个 agent 到底由什么构成」定死，并把它命名为**清单**。

## 二、清单字段（四组）

### 第 0 组：展示 —— 给人看的身份

```ts
id: string          // 稳定标识，进审计、进目录名、进令牌绑定
label: string       // 给人看的名字，例如 "Claude Code"
icon: AgentIcon     // 见下
```

`icon`：**仓库内相对路径**（SVG 优先），面板与托盘读**同一份**。
不要两处各写一份图标、也不要放 base64 进代码 —— 图标是资产，不是逻辑。

> 决定：图标随清单走，落在 `packages/contracts/assets/agents/<id>.svg`。
> macOS 托盘需要 png 的地方由构建期转换，不在清单里存两份。

### 第 1 组：持久化目录 —— 让历史活过容器

```ts
statePaths: readonly {
  path: string        // 相对**舱内 home** 的路径，例如 '~/.claude'
  mode: 'rw'          // 目前只允许 rw；没有 ro 的用例
}[]
```

- 语义：这一条声明「这个 agent 把历史写在哪」，abx 据此把它挂到一个**按实例持久化**的宿主目录上。
- **必须写在清单里，不能写在渲染器或挂载策略里**。理由：路径是**某个 agent 的性质**，会随 agent 版本漂移（claude 换过目录布局）。写在代码里的那份表，没人会记得跟着 agent 升级一起改。
- 宿主侧布局与安全边界见 `persistence.md`（并行作业 P 正在落）。

### 第 2 组：镜像地址 —— 拿什么起服务

```ts
image: {
  repository: string        // 例如 'ghcr.io/yinxulai/abx-agent-claude'
  tag: string               // 语义版本或 'latest'；**建议按 agent 版本走**
  digest?: string           // 可选，钉死到具体镜像
  entrypoint?: readonly string[]  // 可选，覆盖镜像默认
}
command: string             // 舱内可执行名，例如 'claude'
args: readonly string[]
```

- **镜像必须按 agent 给，全局那份只作兜底默认**。`session.image` 保留为「清单里没写时的默认值」，不再当作三个 agent 的共同镜像。
- 镜像地址进清单，是为了让「更新检查」有东西可查：manifest 里写 tag，宿主侧比对远端 tag 就能告诉用户「该更新了」。
- 三个 agent 的镜像**各自装各自的 CLI**，互不影响版本。

> 待拍板：registry 放哪（GHCR 公开 / 私有 / 自建）。清单字段先按 `ghcr.io/yinxulai/abx-agent-<id>` 写，registry 定了只换前缀。

### 第 3 组：配置模板（含落盘位置）—— 把 abx 的接线渲染进去

```ts
configFiles: readonly {
  path: string              // 相对**舱内 home**，例如 '~/.claude/settings.json'
  format: 'json' | 'toml' | 'yaml'
  template: string          // 内容**模板**，见下
  mount: 'ro'               // 生成后只读挂进舱
}[]
```

**模板是数据，不是代码。** 这是本次最重要的改动：

- 现在：`agent-config.ts` 里三套生成逻辑按 format 分支手写，内容写死。
- 目标：清单里放**模板字符串**，渲染器只做一件事 —— 把固定变量替换进去，然后按 format 序列化。
- 渲染器于是变得和 agent 无关：**加一个 agent 真的只加一条清单**，那句注释变成实话。

**变量是白名单，写错就失败**（fail closed）：

| 变量 | 含义 |
|---|---|
| `${cellOrigin}` | 舱面地址，例如 `http://host.docker.internal:8789` |
| `${upstreamId}` | 这个 agent 走的上游 id |
| `${cellToken}` | **本次会话**的舱令牌（一次一换，不是固定值） |
| `${cellTokenHeader}` / `${cellTokenPathPrefix}` | 按 `cellTokenVia` 二选一 |

- 模板里出现**白名单之外**的变量名 → **直接报错，不渲染**。
  否则模板写错一个字母，渲染出来是空字符串，配置里就多一个空端点 —— 而且不报错，只有真跑才炸。
- **模板里绝不允许出现真实凭据变量**（`secretEnv` 之类的值只进 broker，不进舱）。这一条由加载时扫描 + 渲染变量白名单两道挡住。

### 既有组：上游接线（保持不变）

`upstreamId` / `baseUrlEnv` / `tokenEnv` / `placeholderToken` / `extraEnv` / `cellTokenVia` / `oswClientKey` / `status` / `note`
—— 这些已经落地且有测试，本次不动，只在文档里归位。

## 三、清单的流转

```
contracts/agents.ts     清单（数据，唯一真相）
        │
        ├─→ core/session/agent-config.ts   渲染器：模板 + 白名单变量 → 文件内容
        ├─→ core/session/mount-policy.ts   按 statePaths + configFiles 组挂载清单（两类可写、其余只读）
        ├─→ core/commands/open.ts          按 image/command/args 起舱
        └─→ packages/console               按 label/icon 画面板（托盘同一份）
```

## 四、落地顺序（避开文件撞车）

1. **先等 `p-persist` 合并** —— 它正在改 `contracts/schema.ts`（`cellHome`）、`core/session`（`agent-config` 的
   home 展开）、`mount-policy.ts`。清单重构会碰同一批文件，同时改必然冲突。
2. 再开一条线做清单重构，顺序：
   - 先把**镜像**移进清单（改动最小、收益直接：现在三个 agent 共用一个没有 CLI 的镜像）
   - 再把**配置内容**改成模板（渲染器与 agent 解耦）
   - 再把 **statePaths** 从 P 线的表里搬进清单
   - 最后补 **icon**（面板与托盘共用）
3. `status` 字段的 `unconfirmed → stable` 仍然要**逐个核对真实字段**才能转，不许因为「清单写全了」就顺手转。

## 五、验收（写给实现那条线）

- 加一个**假 agent**（只在测试里加一条清单，不碰任何渲染器/后端代码）能跑通：起舱参数、挂载清单、
  配置内容三样都按清单产出。这条测试是「清单真的是唯一真相」的判据。
- 模板变量白名单：写一个含未知变量的模板 → **必须报错**，不许渲染出空值。
- `statePaths` 为空数组的 agent：不许挂任何持久化目录，且不能因此崩。
- 镜像：断言每条清单都有自己的镜像，全局 `session.image` 只作兜底。
