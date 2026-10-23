# 真实 Docker 验证：舱 ↔ 舱面

**这份文档回答的是**：容器里的舱到底能不能连上宿主的气闸，怎么验的，原始证据长什么样，
以及验证过程中发现的**与设计文档不一致的地方**。

设计与结论在 [`../overview/architecture.md`](../overview/architecture.md) §19（那一节是设计与取舍），
本文是**原始证据与运维细节**。进度与验收状态不在这里，在 [`../../roadmap.md`](../../roadmap.md)。

脚本：`packages/toolkit/scripts/e2e-docker.sh`。

---

## 0. 怎么跑

```
bash packages/toolkit/scripts/e2e-docker.sh          # 跑全部
bash packages/toolkit/scripts/e2e-docker.sh --keep   # 跑完不清理临时目录
```

退出码只有两种含义：

| 退出码 | 含义 |
|---|---|
| `0` | 硬断言全过。**docker 不可用也走这条** —— 那种情况下脚本会明说「这次没有验证任何东西」 |
| `1` | 某条硬断言没过（舱内连不上、令牌校验不对、或者三条候选地址一条都不通） |

脚本会**起真的 broker**（`packages/core/source/broker`），不是替身服务——要验的就是
「舱面认不认令牌」，用一个自己写的替身来验等于没验。唯一假的是上游，因为要断言的是
「上游收到了什么」，真上游不会告诉你。

第 5 步的**规格探针**不进退出码：它验的是设计文档要求了、而实现里还没有的东西。
「没实现」是现状，不是这次改动引入的回归，用红色退出码表达它会让这个脚本失去
「能跑通就是好的」这个信号。但它**会**被打印出来，并计入结论里的「规格未满足 N 条」。

参数：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ABX_E2E_IMAGE` | `node:22-slim` | 与 `abx.config.json` 的 `session.image` 保持一致 |

---

## 1. 环境

本机实测（2026-10-23）：

| 项 | 值 |
|---|---|
| 宿主 | Linux（Docker Desktop for Linux） |
| Docker Desktop | 4.96.0 (243774) |
| Engine（VM 内） | 29.9.1，API 1.56 |
| 客户端 | 29.9.2 |
| 镜像 | `node:22-slim` |
| 容器自身地址 | `172.17.0.2` |
| 容器默认网关 | `172.17.0.1`（`/proc/net/route` 实测） |
| 起 docker 的方式 | `systemctl --user start docker-desktop`（用户级，不需要 sudo） |

> 以上全是 Linux 版 Docker Desktop 上的结果。**macOS 真机没验**，见 §8。

---

## 2. 三条地址，哪条真的通

脚本第 2 步的原始输出（一次真实运行，端口是系统分配的，每次不同）：

```
$ docker run --rm node:22-slim getent hosts host.docker.internal
  结果：192.168.65.2    host.docker.internal

$ docker run --rm node:22-slim node -e '<依次尝试 host.docker.internal / 172.17.0.1 / 192.168.65.2>' 42971
  （探 /healthz 不带令牌：HTTP 401 = 到了舱面；ECONNREFUSED = 没连上）
  host.docker.internal -> HTTP 401
  172.17.0.1 -> ECONNREFUSED: fetch failed
  192.168.65.2 -> HTTP 401
```

配合同一次运行里「宿主能不能绑这些地址」的结果：

```
$ node -e 'createServer().listen(0, "172.17.0.1")'
  结果：EADDRNOTAVAIL
```

合起来就是 §19.1 那张表，逐条复现：

| 地址 | 宿主能否绑定 | 舱内能否连到 | 为什么 |
|---|---|---|---|
| `172.17.0.1` | ❌ `EADDRNOTAVAIL` | ❌ `ECONNREFUSED` | 它是 **VM 内部**的 `docker0` 网桥：既不属于宿主（所以绑不上），也不指向宿主（所以连过去是 VM 自己） |
| `host.docker.internal` | —（是 DNS 名） | ✅ 到了舱面 | Docker 注入的 DNS，解析到 VM 的宿主网关 `192.168.65.2` |
| `192.168.65.2` | —（在 VM 里） | ✅ 到了舱面 | 同上，直接写 IP 的等价形式 |

**为什么 HTTP 401 算「通了」**：`/healthz` 在舱面上也要令牌（`broker/server.ts` 里令牌检查在
路由之前），不带令牌拿到 401 恰恰证明「请求到达了舱面」。真连不上是 `ECONNREFUSED`
或者超时。脚本靠这个区分「到了但没带钥匙」和「根本没到」。

**一个容易被忽略的细节**：宿主上的 `0.0.0.0` 是能绑的，实测监听套接字是全网卡的 ——

```
$ ss -ltn | grep :28732
LISTEN 0      511                                   0.0.0.0:28732      0.0.0.0:*
```

对照宿主面（`127.0.0.1:...`）——**只有舱面是全网卡**。这不是配置疏忽，是 §19.1 的结论：
在 Docker Desktop 上，舱面除了 `0.0.0.0` 没有别的选择。代价见 §4。

### 2.1 `--add-host` 的坑：不要无条件加

原生 linux docker 不会注入 `host.docker.internal` 这个名字，惯例做法是加
`--add-host=host.docker.internal:host-gateway`。**但在 Docker Desktop 上不要加**：

```
$ docker run --rm --add-host=host.docker.internal:host-gateway node:22-slim \
    sh -c 'getent hosts host.docker.internal'
fdc4:f303:9324::254 host.docker.internal      ← 变成了一个 IPv6 ULA 地址
```

而不加的时候是 `192.168.65.2`。舱面绑的是**纯 IPv4 的 `0.0.0.0`**，一个指向 IPv6 的名字
理论上会让它连不上。

实测结果要诚实说：**这次没坏**。加了 `--add-host` 之后请求仍然通 —— 说明 IPv4 那条记录
还来自 Docker 自己的 DNS，`/etc/hosts` 里那条 IPv6 没把它顶掉。但这属于「这次没踩到」，
不是「这个参数安全」。

所以脚本的规则是：**先 `getent hosts` 探一下，解析不出来才加这个参数**。
不要反过来。

---

## 3. 探测规则

「探测后决定」不能用一句 `if darwin` 代替 —— §19.1 的教训就是「文档说的和机器做的
不是一回事」，唯一可靠的做法是**问机器**。脚本第 2 步的判定：

1. `getent hosts host.docker.internal` —— 解析不出来就补 `--add-host` 再解一次
2. 依次从舱内探三条候选地址（`host.docker.internal` → `172.17.0.1` → `192.168.65.2`），
   看谁真的到了舱面
3. **取第一条真的通的**当舱面地址；后面的断言全部打这个地址
4. 一条都不通 → 立刻失败，并说明这是宿主侧的问题（防火墙 / 网络模式 / VPN），不是 abx 的问题

第 3 条是关键：脚本不照抄任何约定值。哪天 Docker Desktop 换了网关地址，
这张表会自己变，而不是让断言用一个已经不对的常量继续「通过」。

### 3.1 core 版本的落点在哪、由谁做

**core 里现在没有纯函数形式的地址探测**（`resolveCellHost` 只是
「local 后端 → `127.0.0.1`，否则照抄配置」，见 `core/source/commands/runtime.ts:99`）。
按作业边界，**不许由本作业往 core 里写**。落点与归属：

| 该做什么 | 落点 | 谁做 |
|---|---|---|
| 探测函数本身（纯函数，输入平台 + docker 探测结果，输出 `{ bindHost, cellHost }`） | `core/source/broker/` 下新文件，跟 `server.ts` 放一起 | **作业 B**（`layout.md` §6 里 B 独占 `core/source/broker/{registry,server,token,route}.ts`） |
| 用探测结果决定舱面绑哪 | `core/source/broker/server.ts` 的 `startBroker`（现在是 `options.cellHost ?? config.broker.cellHost`） | **作业 B** |
| 用探测结果决定舱内 `BASE_URL` / `ABX_BROKER_ORIGIN` 里的 host | `core/source/session/env.ts` 的 `buildCellEnv`（舱内 host 由调用方传进来） | **作业 C**（独占 `core/source/session/{agent-config,mount-policy,docker-backend,env}.ts`） |

**形状建议**：纯函数 + 注入 I/O，与现有的 `probeUserNamespaces(readFile)`、`probeDocker(path)`
保持同一种风格——探测本身做 I/O，**判定是纯的**，这样判定能单测，不用起 docker。

`roadmap.md` 里「补齐 §19 的两处修正（舱面地址探测、共享路径检查）」就是这两条；
`layout.md` §6 的作业表里**没有单独列出「地址探测」这一项**，落地时要么归 B，要么补一行。

---

## 4. 来源网段校验为什么必要

这是 §19.1 用一条坏消息换来的推论，值得单独说清楚：

**舱面绑 `0.0.0.0` 不是选择，是 Docker Desktop 上的唯一活路。**（§2 已实测）

**但绑 `0.0.0.0` 把一条原本免费的保护弄丢了。** 原设计（§6.1 的 `I-B2`）是
「不绑 `0.0.0.0`」——靠 bind 地址把「能被谁连上」这件事交给内核。绑了全网卡之后，
**舱面在局域网上是可见的**（`ss` 实测，见 §2），只剩令牌一道门。

而令牌**一定会被打印出来**：它就在舱内 agent 的 `BASE_URL` 里
（`http://host.docker.internal:<舱端口>/c/<舱令牌>/u/osw`，见 §16.1），
agent 复述自己的配置、报错、把 URL 贴进 issue，都是常规操作。一份会出现在终端输出里的
凭据，不能是唯一的门。

所以 §19.1 给的补偿是：**来源网段校验** —— 只接受 `192.168.65.0/24` 与 `172.17.0.0/16`，
网段外即便令牌正确也拒绝。它把「谁能连上」从「整个局域网」收回「docker 的 VM 网段」，
也就是把丢掉的那道门换个位置装回来。

**实测：这道门现在不存在。** 第 5 步的两条证据：

```
正确令牌 + 伪造的 x-abx-cell-id -> HTTP 200
从宿主回环打舱面（来源 127.0.0.1，不在 docker 网段内）-> HTTP 200

$ grep -rn '192\.168\.65\|remoteAddress' packages/core/source packages/contracts/source
  命中 0 行
```

第二条不是「判错了」，是「压根没判」——源码里既没有网段常量，也没有读过来源地址
（有校验就一定会出现 `remoteAddress`）。第一条的 200 同理。

**这不是回归**：`layout.md` §8 的待办清单里没有它，`roadmap.md` §4「明确未验证的」
把「从舱内往外打」列为未验项。也就是说这条补偿措施**写进了设计文档，但没有写进任何
作业的待办**——这正是它容易被漏掉的原因。

---

## 5. 令牌与凭据：跨容器边界的实测

全部从**容器内部**发起。硬断言（第 3、4 步）：

| 场景 | 实测 | 断言 |
|---|---|---|
| 正确令牌，放 `x-abx-cell` 头 | `HTTP 200` | ✅ |
| 正确令牌，放路径 `/c/<token>/`（agent 实际走法，§16.1） | `HTTP 200` | ✅ |
| 错误令牌 | `HTTP 401` | ✅ |
| 不带令牌 | `HTTP 401` | ✅ |
| 只有伪造的 `x-abx-cell-id` 头（拿身份当凭据） | `HTTP 401` | ✅ |

最后一条的含义要说准：它证明的是**身份头不能替代令牌**（`x-abx-cell-id` 不是凭据）。
它**不**证明「身份不可伪造」——那是另一件事，见 §7.2。

第 4 步是完整链路：容器里发一个**带占位符**的请求，看宿主上的假上游收到了什么。

```
$ docker run --rm node:22-slim node --input-type=module -e '<fetch>' \
    http://host.docker.internal:39425/c/<舱令牌>/u/osw/v1/messages \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer abx-placeholder' \
    -H 'x-abx-cell-id: claude-cell-1'

HTTP 200 {"method":"POST","url":"/v1/messages",
  "authorization":"Bearer FAKE-SECRET-e2e-docker-0000-not-a-real-key",
  "x-abx-cell-id":null,
  "body":"{\"model\":\"fake\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"}
```

三件事同时成立，而且都是容器外那一侧说的：

1. **凭据注入跨过了容器边界**：舱内发的是 `Bearer abx-placeholder`，上游收到的是宿主
   环境变量里的真密钥 —— 真密钥从来没进过容器。
2. **占位符没有漏出去**：上游那一侧不含 `abx-placeholder`。
3. **`x-abx-cell-id` 没有转发给上游**（回显里是 `null`）：舱内自报的身份没有跟着请求
   跑出去，`STRIPPED_AUTH_HEADERS` 那一层在跨容器这条路上是生效的。

第 1 条是 abx 的立身之本（「舱里压根不存在一个可以泄漏的密钥」），
**这是它第一次在真容器里被验过**。

---

## 6. 已知坑

### 6.1 Docker Desktop 的共享路径

**现象**：挂载源落在共享范围外，容器根本起不来，报错长这样（脚本第 6 步复现的原文）：

```
docker: Error response from daemon: mounts denied:
The path /tmp/abx-e2e-docker-eXAMPLE/mount-source is not shared from the host and is not known to Docker.
You can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.
See https://docs.docker.com/ for more info.
```

**为什么这条报错难懂**：它说的是「这个路径没被共享」，但用户心里的问题是
「**那我该把项目搬到哪**」。它给了入口（Preferences）却没给答案，而且
「not known to Docker」听着像是路径写错了——于是大量时间会花在检查拼写和权限上。

**⚠️ 这里有一处与 §19.2 不一致，实测推翻了一半。** §19.2 说「本机 Linux 版只共享 `/home`」。
实测这台机器**不是**这样——共享集合不是「home 以下」，也不是任何简单的前缀规则：

| 路径 | 能否挂载 | | 路径 | 能否挂载 |
|---|---|---|---|---|
| `/home` | ✅ | | `/tmp` | ❌ |
| `/usr` | ✅ | | `/opt` | ❌ |
| `/var` | ✅ | | `/srv` | ❌ |
| `/etc` | ✅ | | `/root` | ❌ |
| | | | `/mnt` / `/media` | ❌ |

（`~/.docker/desktop/settings-store.json` 里**没有**记录这份名单，只有
`AutoStart` / `EnableDockerAI` / `SettingsVersion` 三个键。也就是说它不可读、不可预测。）

**所以 §19.2 里「对每个挂载源做共享路径检查」这个做法要改**：拿一份前缀列表去比对，
在这台机器上会**同时误报和漏报**（`/etc` 会被拦下、`/tmp` 会被放行）。可靠的做法只有两个：

- ✅ **推荐：让 docker 去挂，捕获 daemon 的报错，翻译成人话。** 永远与真实行为一致，
  不需要维护任何名单。
- ⚠️ 备选：启动时真挂一次探测并缓存结果。多一次容器启动，但能提前发现。

**人话提示该这么写**（`MOUNT_POLICY` 失败时给用户看的东西）：

```
这个目录不在 Docker 能看到的范围里：
  /Users/alex/Projects/foo

Docker 只允许挂载它被授权的目录。三个办法，任选一个：

  1. 把项目放到 ~ 下面（最省事，推荐）
  2. Docker Desktop → Settings → Resources → File sharing 里加上
     /Users/alex/Projects，然后重启 Docker Desktop
  3. 只把需要的那几个文件拖进 abx 的共享区（~/.abx/shared/ 天然在 ~ 下，不受这条限制）

排查用的原始报错：
  mounts denied: The path /Users/alex/Projects/foo is not shared from the host ...
```

三个要点：**指到具体是哪个目录**、**给可执行的选项而不是给设置面板的位置**、
**附上原始报错**（用户要贴给别人的时候不用再跑一遍）。

> 顺带解释了 `~/.abx/shared/` 与 `~/.abx/outbox/` 为什么选在 `~` 下（§18.5）——
> 不只是习惯，是这个坑倒逼的结果。

### 6.2 `node:22-slim` 里既没有 `curl` 也没有 `wget`

```
$ docker run --rm node:22-slim sh -c 'command -v curl || command -v wget || echo NO'
NO
```

所以脚本用**镜像自带的 node** 发请求（`fetch` 是 node 18+ 的全局能力）。
`ALPINE`/`debian` 里装 curl 会让「验证网络连通性」这件事依赖一次额外的包安装，
不值当。换 `ABX_E2E_IMAGE` 到带 curl 的镜像时脚本照样能用。

**这条会一直误导人**：随手写 `docker run --rm node:22-slim curl ...` 会得到
`executable file not found`，看起来像网络问题，其实是镜像里没这个命令。

### 6.3 core 的 TS 源码不能被 node 直接跑

`packages/core` 内部用**无扩展名** import（`from './audit'`）。vitest 认这个写法，
node 的 ESM 解析器不认：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../packages/core/source/broker/audit' imported from '.../broker/index.ts'
```

脚本在临时目录里放了一个十几行的解析钩子（只做「补 `.ts` / 补 `/index.ts`」），
用 `node --import` 挂上去。**没有新增依赖，用的全是 node 内置模块。**

> 这也是 `apps/cli` 被删掉之后留下的一处陈旧：`packages/toolkit/scripts/e2e-local.sh`
> 仍然在调 `node apps/cli/source/index.ts`，而 `apps/` 下已经只有 `app` / `docs` / `www`。
> 本作业没有改它（不在范围内），但**它现在跑不起来**，谁要用先修它的入口。
> 另：它的 `ROOT` 算的是 `packages/toolkit`，后面却按仓库根用相对路径，这两处对不上。

---

## 7. 本次实测发现的不一致

**这一节比脚本本身重要。** 每条都是「设计文档这么说 / 机器这么做」，都带可复现的证据。

### 7.1 §19.1 的来源网段校验：不存在

- **文档**：§19.1 修正后的规则第 4 条、§16.2 的缓解措施、§6.1 的 `I-B2` 都写明
  「非 docker VM 网段的请求一律拒绝，即便令牌正确」。
- **实测**：宿主回环打舱面 → `200`；`grep 192.168.65|remoteAddress` → **0 行**。
- **影响**：舱面绑 `0.0.0.0` 的代价已经付了，补偿没装。**这是本次发现里唯一一条安全问题。**
- **落点**：`core/source/broker/server.ts` 的 `handleRequest`，令牌检查旁边（**作业 B**）。
  实现上要小心：`remoteAddress` 在反向代理后面不可信，不能只看它。

### 7.2 §20.3 的令牌注册表：未落地，cellId 仍可伪造

- **文档**：§20.3（本轮拍板）明确写了「⚠️ 当前实现不满足」，要求改成令牌注册表，
  `cellId` 从令牌反查、不读请求头。
- **实测**：`正确令牌 + 伪造 x-abx-cell-id → 200`（脚本第 5 步）。
  代码侧也写明了：`packages/contracts/source/agents.ts:73` 的注释是
  「这个头不参与鉴权（它由舱内自报），所以伪造它只是让日志难看，不构成放行」。
- **影响**：对一个以留痕为卖点的产品，**审计里的舱归属可以被伪造**。不是放行漏洞，
  是可信度漏洞。
- **落点**：`core/source/broker/registry.ts`（`layout.md` §6 归 **作业 B**，
  `layout.md` §8 的待办清单里已列）。
- **脚本里怎么处理**：第 5 步的探针。**B 落地之后，这条会自己变成绿色**（探针判 401），
  届时把它升级成第 3 步的硬断言。

### 7.3 §19.1 的规则 1（`cellHost` 默认 `0.0.0.0`）：未落地

- **文档**：§19.1「修正后的规则」第 1 条：`cellHost` 默认 **`0.0.0.0`**，不是网桥地址。
- **实际**：`packages/contracts/source/load-config.ts:37` 是 `cellHost: '172.17.0.1'`，
  `abx.config.json` 里是 `"${ABX_CELL_HOST:-172.17.0.1}"`，
  而 `resolveCellHost`（`core/source/commands/runtime.ts:99`）只对 `local` 后端改写。
- **后果**（实测，docker **正在运行**的情况下）：

  ```
  失败：舱面起不来（broker.cellHost=172.17.0.1 broker.cellPort=0）：
      listen EADDRNOTAVAIL: address not available 172.17.0.1
    docker 没起来时 172.17.0.1 这个网桥地址并不存在。用 local 后端跑的时候请把
    cellHost 指到 127.0.0.1，或者设 session.backend=docker。
  ```

  即：**默认配置（`session.backend=docker`）在 Docker Desktop 上起不来**，
  而 abx 只做 macOS，macOS 只有 Docker Desktop。§19.1 已经把这条列为「原默认值 100% 起不来」。
- **附带一处文案不准**：上面那句提示把原因归给「docker 没起来」，但这次 docker 是**起着的**。
  在 Docker Desktop 上，那个地址**从来就不存在于宿主**，跟 docker 起没起无关。
  这句话会把排查方向带偏。
- **落点**：`DEFAULT_CONFIG` 归 **作业 A**（独占 `contracts/source/load-config.ts`），
  探测函数归 **作业 B**（§3.1）。
- `roadmap.md` §五 已经把「补齐 §19 的两处修正」列成未完成项，与实测一致。

### 7.4 §16.2 的关键设计 D4（令牌带 `abx_cell_` 前缀）：未落地

- **文档**：§16.2「D4：令牌格式带可识别前缀 `abx_cell_`」，理由是让泄漏检测
  **从语义猜测变成字符串匹配**（CI、提交前钩子、日志扫描共用一条规则）。
- **实际**：`core/source/broker/token.ts` 的 `generateCellToken()` 是
  `randomBytes(32).toString('hex')` —— **纯十六进制，没有任何前缀**。
  全仓库搜 `abx_cell_`，只命中一个错误码常量 `abx_cell_token_required`。
- **影响**：§16.2 表格里「令牌进 git 历史」那一行的缓解措施**没有可匹配的串**。
  一个 64 位十六进制串在日志里和 sha256、随机 id、会话 id 长得一模一样 ——
  这正是 D4 想避免的情况。
- **落点**：`core/source/broker/token.ts`（**作业 B**）。
  注意 §19.3 里引用的 `ABX_CELL_TOKEN=abx_cell_placeholder` 是 airlock 阶段的实现，
  与当前代码不符。

### 7.5 §19.2 的「Linux 版只共享 `/home`」：与本机实测不符

见 §6.1 的表格。结论：**别按前缀列表判断共享范围**，改成「让 docker 去挂、翻译报错」。

---

## 8. 这次没有验的

**不许把没验的当成验过了。** 以下是本次**没有**覆盖的，逐条说明为什么：

| 项 | 为什么没验 |
|---|---|
| **macOS 真机** | 全部在 Linux 版 Docker Desktop 上跑的。macOS 的共享路径默认值、VM 网关地址、`host.docker.internal` 的解析都**可能不同**，必须在真机重跑这个脚本 |
| **局域网里另一台机器打舱面** | 只验到「宿主回环也能打」（§4）。局域网可达性没法在本机造出来，而它恰恰是网段校验要防的场景 |
| **真实 agent 二进制** | 舱内跑的一直是脚本，不是真的 Claude Code / Codex |
| **真实 agent 的出网域名集合** | 本次只打了 `/healthz` 和一条 `/u/osw/...`，没有让真 agent 跑起来看它还会连哪些域名 |
| **`ANTHROPIC_CUSTOM_HEADERS` 的多行格式** | 与本次无关，仍是推断（§19.4） |
| **舱面的 IPv6 可达性** | 舱面绑 `0.0.0.0`（纯 IPv4）。加 `--add-host` 会把它解析成 IPv6（§2.1），这条路上的行为没细究 |
| **会话编排与挂载** | 本次只起 broker + 容器，没有走 `session.create()`；挂载策略、outbox、共享区都没碰 |
| **审计** | 脚本起了审计 sink，但没有对着它做断言（`e2e-local.sh` 管这一段） |

---

## 9. 什么时候要重跑

- **换机器**（尤其 macOS 真机）：§2 的三条地址结论与 §6.1 的共享范围都可能变。
- **Docker Desktop 升级**：VM 网关地址、`host.docker.internal` 的解析方式都动过。
- **`core/source/broker/**` 或 `core/source/session/**` 改动之后**：这是唯一会跨容器边界
  验它们的检查。
- **§7 里任何一条落地之后**：对应的探针会翻绿，届时把 7.2 从探针升级成硬断言。

---

*本文记录的是实测证据，不是设计。设计改动请改
[`../overview/architecture.md`](../overview/architecture.md) §19，本文只跟着证据走。*
