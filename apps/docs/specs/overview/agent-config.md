# agent 配置与上游接线

**决定（2026-10-23）**：每个 agent 的配置由 **abx 生成**，以**只读**方式挂载进舱；
配置里只有一个供应商、一个 baseUrl，指向气闸舱面；气闸**默认上游是 OSW**。
于是「模型管理」与「渠道切换」全部留在 OSW，abx 不复制任何供应商配置。

**并且：不需要修改 OSW。** OSW 现在提供出去的就是一个**没有鉴权的 baseUrl 服务**。

---

## 1. 接线图

```
舱内 agent
  └─ 读只读配置：只有一个 baseUrl（= 气闸舱面）+ 一个占位符 token
        │
        ▼
  气闸舱面（宿主，绑 0.0.0.0）        ← 校验舱令牌 + 出口白名单 + 记审计
        │  替换/剥离鉴权头
        ▼
  OSW 代理（宿主，127.0.0.1:9300）   ← 无鉴权；真正的供应商、密钥、模型、故障转移都在这
        │
        ▼
  真实供应商 API
```

三层各管一件事，**没有一层需要知道下一层的密钥**。

## 2. 为什么「不改 OSW」是成立的

OSW 的代理面**没有鉴权**，这是它的设计而不是缺陷：它只监听回环地址
（`proxyPort` 9300 生产 / 19300 开发），局域网与本机其他用户都够不到它。

**这条性质正好被 abx 用上**：

| 谁 | 能不能碰到 OSW |
|---|---|
| 舱内 agent（容器） | ❌ 碰不到 —— 容器只能经 `host.docker.internal` 访问宿主**对外监听**的端口，而 127.0.0.1 不上任何对外接口 |
| 气闸（宿主进程） | ✅ 能 —— 它就是宿主进程，直连 127.0.0.1:9300 |

所以**气闸是舱内唯一的出口**，而 OSW 继续只做它自己那件事。
不需要给 OSW 加鉴权、加监听面、加舱身份头 —— 那三样原本列在
`design.md` §12 的「需要给 OSW 补三样」，**现在全部取消**。

> OSW 的管理 API 同样没有身份校验（见它的 `operations/security-privacy.md`）。
> 所以「只允许读写哪些文件」这条边界它写在代码里，绝不让路径由调用方给。
> 这条约束对 abx 同样适用：**不许把路径作为参数交给一个无鉴权的本地服务**。

## 3. ⚠️ 配置挂载的三个坑

### 3.1 绝不要挂 `configDir` 整个目录

OSW 的客户端注册表（`packages/contracts/source/clients/*/definition.json`）
登记了每个 client 的配置文件，**里面混着真凭据**：

| client | 配置文件 | 同目录下的**凭据**文件 |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | ⚠️ `~/.claude/.credentials.json`（Claude 账户 OAuth） |
| `codex` | `~/.codex/config.toml` | ⚠️ `~/.codex/auth.json` |
| `deepseek-harness` | `~/.dsh/settings.yaml`、`~/.dsh/config.yaml` | — |
| `opencode` | `~/.config/opencode/opencode.json` | ⚠️ `~/.local/share/opencode/auth.json` |
| `pi` | `~/.pi/agent/settings.json`、`models.json` | ⚠️ `~/.pi/agent/auth.json` |

**「把 agent 配置整个目录只读挂进去」= 把 OAuth 凭据送进舱。**
舱内 agent 本来就能读 `~/.claude/.credentials.json`，那整个凭据不外泄的承诺就没了。

**规则：只挂「需要的那一个文件」，逐个白名单，绝不挂目录。**
凭据文件名进 `FORBIDDEN_MOUNT_PREFIXES` 的同级黑名单（挂载源命中即拒绝）：
`.credentials.json`、`auth.json`、`*.env`、以及 §15 已有的密钥形名单。

### 3.2 不要挂宿主的真实配置文件

宿主那份 `settings.json` 里可能已经写着别家的 key、别的端点、别的模型。
挂真的等于把它带进舱。

**abx 生成一份最小配置**：只有 `baseUrl` 与占位符。宿主那份一个字都不进舱。

### 3.3 路径必须与宿主一致

D2（`architecture.md` §15）已经定了「舱内路径与宿主路径完全一致」。
生成出来的配置也照此挂在 `~/.claude/settings.json` 这样的位置上 ——
agent 不会去找别的地方，路径不一致等于没配。

## 4. 生成的配置长什么样（Claude Code 为例）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:8789/c/<舱令牌>/u/osw",
    "ANTHROPIC_AUTH_TOKEN": "abx-placeholder"
  }
}
```

- `ANTHROPIC_BASE_URL` 指向**气闸舱面**，不是 OSW。气闸再把请求转给 OSW。
- `ANTHROPIC_AUTH_TOKEN` 是**占位符**，气闸无条件处理掉它，不校验其内容
  （见 `architecture.md` §16「agent 不会自己加请求头」）。
- 没有 `model` 字段：**换模型是 OSW 的事**，abx 不参与，也不该写死。

## 5. 上游：osw 是唯一生产下游

`abx.config.json` 里新增 `osw` 上游，`baseUrl = http://127.0.0.1:9300`（生产端口）。

**它没有 `secretEnv`** —— 因为 OSW 不需要鉴权。所以气闸对它的行为是
**剥离**鉴权头，而不是注入：

```
上游配了 secretEnv  → 用真密钥覆盖该头（直连真实供应商）
上游没配 secretEnv  → 剥掉该头再转发（下游自己会处理鉴权，例如 OSW）
```

原来那三个直连上游（`anthropic` / `openai` / `dsh`）**保留，但仅限开发期与自测**；
生产形态下气闸的唯一下游就是 `osw`。

## 6. agent id ↔ OSW client key

`dsh` 不是我们编的名字，它对应 OSW 注册表里的 **`deepseek-harness`**（配置在 `~/.dsh/`）。

| abx agent id | OSW client key | 配置文件 |
|---|---|---|
| `claude` | `claude-code` | `~/.claude/settings.json` |
| `codex` | `codex` | `~/.codex/config.toml` |
| `dsh` | `deepseek-harness` | `~/.dsh/settings.yaml` |

`claude` 与 `codex` 的 `status` 可以从 `unconfirmed` 转 `stable`：
**路径与字段名现在有权威来源了**（OSW 的注册表），不用再按通用约定猜。

> `dsh` 的三样（命令名、`baseUrlEnv`、`tokenEnv`）仍需要在
> `~/.dsh/settings.yaml` 的真实字段里核对一次才能改 `stable`。

## 7. 待办

- [ ] `core/mounts`：生成配置 → 落到 `~/.abx/cells/<cellId>/agents/<agentId>/` → 单文件 `ro` 挂载
- [ ] 挂载源黑名单：加入凭据文件名（§3.1）
- [ ] `AGENT_DEFINITIONS` 补 `configFiles` 字段，与 OSW 注册表对齐
- [ ] 起舱前的挂载源共享路径检查（`architecture.md` §19.2）
