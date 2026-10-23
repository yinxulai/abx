# 共享给全部 agent：拖进来的目录，真的出现在舱内

**决定（2026-10-23）**：共享区支持**文件与目录**两类条目，一律**只读**挂进舱内
`/shared/<名字>`；目录**整挂**，不拆成一个个文件。

这条规格讲的是用户看得到的那一段：拖进来之后发生什么、舱内叫什么、什么东西进不来、
以及列表怎么活过重启。挂载闸门本身的规则在
[`../overview/persistence.md`](../overview/persistence.md) §5，两者是同一套语言。

## 1. 一条条目的形状

```ts
{ path: string, kind: 'file' | 'directory' }
```

- `path` 必须是**绝对路径**，规范化之后不许含 `..`，空串直接拒（契约层
  `sharedEntrySchema` 就拦一次，core 再拦一次——`resolveSharedMounts()` 是可以被
  直接调的）。
- `kind` **只有一个权威来源：宿主 `stat`**。拖放那一刻浏览器给的
  `webkitGetAsEntry().isDirectory` 只是预览，用来让图标立刻出现；软链是什么、
  条目还在不在，只有 stat 说得清。**绝不能用 `File.size === 0` 判断目录**——
  0 字节的空文件和空目录都是 0，用它判的话两者会互相顶替。

## 2. 舱内它叫什么

| 宿主 | 舱内 | 挂载模式 |
|---|---|---|
| `/Users/alain/projects/notes`（目录） | `/shared/notes` | `ro` |
| `/Users/alain/specs/design.pdf`（文件） | `/shared/design.pdf` | `ro` |
| `/Users/alain/archive/notes`（与第一条重名） | `/shared/notes-2` | `ro` |

- 名字取 `basename` 消毒之后的结果：不含分隔符、不是 `.` / `..`、不含控制字符
  （控制字符能骗过终端显示，而挂载点会进日志与审计）。消毒后为空就用 `shared-<序号>`。
- 重名往后排 `-2` / `-3`，且**稳定**：同一批条目每次算出来都一样。撞车意味着后一个
  把前一个盖掉，舱内只剩一个，而界面上明明列着两个。
- **挂载点由 core 算，调用方给不了**（`resolveSharedMounts()` 的入参里根本没有目标路径）。
  让调用方指定挂载点，等于把「往舱内哪个位置放东西」交给外面，而那正是最容易写错的一处。

## 3. 目录为什么整挂

拆成一个个文件挂有两个后果，都是**静默**的：

1. 1000 个文件就是 1000 条 `-v` 参数；
2. 更要命的是**目录里新增的文件永远不出现**——用户以为共享的是一个目录，
   实际拿到的是拖进来那一刻的快照。他在舱内看不到刚写出来的 `report.md`，
   而界面上一切正常。

整挂之后，宿主上往那个目录里放东西，舱内**立刻**看得到（`e2e-shared.sh` 第 6 条用例
就是拿这个当判据：整目录绑定，不是快照）。

## 4. 什么东西进不来

共享源要过四道闸，每条都对应一种具体的逃逸：

| 闸门 | 挡住什么 | 例子 |
|---|---|---|
| ① 形状与存在性 | 空的、相对的、含 `..` 的路径；宿主上找不到的；既不是普通文件也不是目录的 | 拖进来一个已经被删掉的目录；一个 socket |
| ② 先 realpath，再判前缀 | `~/notes` 可以是指向 `~/.ssh` 的软链——不解析前缀一个字都拦不住 | 软链条目**按目标判定**，拒绝理由里会写明「这是符号链接，按它解析后的目标判定」 |
| ③ 凭据文件名 | 名字命中 `.credentials.json` / `auth.json` / `*.env` / `*.pem` / `id_rsa*` 等规则的，**单个文件也一样拒** | 直接把 `~/.claude/.credentials.json` 拖进来 |
| ④ 目录内容扫描 | 目录里**任何深度**命中凭据规则的文件；扫不动的子目录；条目数超过上界 | 共享一个装着 `.env` 的项目目录 |

另外还有「哪些地方不能当共享源」：文件系统的根、宿主 home **本身**（共享要指到主目录
下面的某个具体目录）、与实例根重叠的路径（互为祖先或后代都不行）、主目录下的身份目录
（`.ssh` / `.aws` / `.kube` / `.claude`……），以及 `/etc` `/proc` `/sys` `/dev` `/root`
`/run` `/var/run` 这些禁挂前缀。

> `/home` 在配置文件那条链上是禁挂前缀，**对共享让开**：用户的项目就住在主目录下面，
> 不开这个口子等于共享根本用不了。让开之后 `.ssh` 那几处单列一条补回来——这是共享与
> 配置文件必须分开的地方。

扫描有两个刻意的取值：`.git` 整个跳过（它能把条目上界无意义地打满，而凭据不会躺在对象库里），
上界 `20000` 个条目、超了就**报错**而不是扫到一半当没事。读不动的子目录算命中——
证明不了「里面没有凭据」和「里面有凭据」在这里是同一个结论。

## 5. 被拒的条目在界面上长什么样

- **不进共享列表。** 列在那里就等于说「它共享上了」。
- 共享区下方给**一行明确原因**，逐条列：`1 项未加入共享区` +
  `notes/.env 目录里有凭据文件：notes/.env 命中 *.env（共 1 个）。`
  面板上显示理由的第一句（「因为什么被拒」），完整那句在 `title` 里。
- **不是 toast、不是弹窗**：用户回头再看列表时，那句话还得在原处等他，而不是三秒后自己没了。
- 理由必须解释「为什么是拒整个目录、而不是少挂那几个文件」：嵌套挂载只能往上加、
  减不掉；而静默少挂几个文件、让用户以为整个目录都共享了，比直接拒绝危险得多。
  不解释的话，他大概率会去找一个更宽的共享方式——而那个方式通常是把整个主目录挂进去。

一条坏条目**不抛异常**：会话不该因为一个被删掉的目录起不来。只有一种情况是错——
调用方要求「至少挂上一个」（`requireAtLeastOne`）却一个都没挂上，那时抛
`MountPolicyViolation`。真正起会话的那一层应该传 `true`：用户拖了东西进来、
一个都没挂上却照常起舱，是最坏的一种失败。

## 6. 列表活过重启

```
宿主：~/.abx/                                     （ABX_INSTANCES_ROOT 可覆盖）
  ├─ shared.json                                 共享列表，0600，目录 0700
  └─ instances/…                                 实例状态（见 persistence.md）
```

- 路径由**宿主**算（`defaultSharedListPath()`），preload 与渲染层都拿不到它。
- 写入是「先写同目录临时文件再 `rename`」：面板在别的进程里，读到半个 JSON 的概率
  不为零，而这份列表是方便、不是数据——坏字节不该让人打不开面板（读不动/JSON 坏了/
  单条记录不合法一律跳过，最坏情况是空列表）。
- **失效的条目不会被删，只会标 `missing`**：文件被删了、盘没挂上，是「现在挂不了」，
  不是「用户不要了」。abx 替用户把条目删掉等于悄悄改他的东西；界面上标一行
  `已失效` 既说清了现状，也把决定权留在他手里。
- 被拒的条目**不写进 `shared.json`**：写进去就成了「面板上看着共享了、实际没有」，
  而下一次打开面板时那一条看起来完全正常。拒绝理由只活在当前这次运行的内存里。

## 7. 代码落点

| 文件 | 职责 |
|---|---|
| `packages/contracts/source/shared-entry.ts` | `sharedEntrySchema`、`SharedEntry` / `SharedEntryState` / `SharedEntryRejection` / `SharedListSnapshot`、`parseSharedEntry` |
| `packages/core/source/session/shared.ts` | `resolveSharedMounts`（四道闸、整挂、命名去重、目录扫描）、`inspectSharedEntry`（kind 的权威来源）、`sharedSourceViolationReason` |
| `packages/core/source/session/shared-store.ts` | `readSharedEntries` / `writeSharedEntries` / `addSharedEntries` / `markMissingEntries` / `defaultSharedListPath` |
| `packages/core/source/session/mount-policy.ts` | `SHARED_CELL_ROOT`、共享挂载的允许清单（按 `target` 认，模式必须是 `ro`）、`buildMounts` 的 `sharedMounts` 入参 |
| `apps/app/source/drop-entry.ts` | 拖放的即时预览（`webkitGetAsEntry`），纯函数、不 import electron |
| `apps/app/source/preload.ts` | `webUtils.getPathForFile` 换出绝对路径；推预览、要快照 |
| `apps/app/source/main.ts` | 解析 → 落盘 → 回快照；`shared:list` / `shared:add` 两个 IPC |
| `packages/console/source/App.tsx` | 渲染宿主快照（目录 `◰` / 文件 `▤`、`只读` / `已失效` / `加入中`） |
| `packages/console/source/components/SharedRejectionList.tsx` | 未加入的条目与原因 |
| `packages/toolkit/scripts/e2e-shared.sh` | 真 docker 验证：整挂可读、写被拒、`.env` 目录拒且容器不起、软链按目标拒、重名 `-2`、新文件立刻可见 |

真 docker 的验证结论以 `e2e-shared.sh` 的实际运行结果为准；进度与验收状态见
[`../../roadmap.md`](../../roadmap.md)。

## 8. 这一版不做

- **可写共享**。挂载模式写死 `ro`，`assertMountPolicy` 里共享挂载只认 `ro`。
- **会话接线**。宿主只做「列表 + 持久化 + 解析接口」，`session.create` 那一侧还要
  在**起容器那一刻**重算一遍（加进来时是干净的，不代表起容器时还是干净的）。
- **移除条目**。列表只增不减；「移除只解除挂载、绝不删原文件」见
  [`functional-design.md`](./functional-design.md) 的可恢复原则。
