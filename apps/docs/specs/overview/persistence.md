# 实例持久化：把历史留在宿主上

**决定（2026-10-23）**：容器仍然 `--rm`，退出即销毁；会话历史活下来靠的是
**按实例**的宿主目录，以 `rw` 挂进舱。实例 id 默认等于 agent id。

```
宿主：~/.abx/instances/<instanceId>/          （ABX_INSTANCES_ROOT 可覆盖）
  ├─ sessions.jsonl                            abx 自己的记账，只写宿主
  └─ <agentId>/                                ← 以 rw 挂进舱
       ├─ projects/…                           agent 自己写的历史
       └─ settings.json                        abx 每次现写，以 ro 嵌在上一行里
舱内：<cellHome>/.<agentId>                     （默认 /home/node/.claude）
```

实例 id 的合法字符：字母、数字、点、下划线、连字符，且以字母或数字开头——
它要当目录名用。

## 1. 为什么是宿主目录，而不是「别删容器」

`--rm` 是安全叙事的一部分，不是省事：

- 容器退出即销毁，上一次运行留下的进程、可执行文件、临时状态**不会**被下一次继承。
  留着容器（`docker start` 复用）等于把「上一次舱内发生了什么」变成下一次的初始条件，
  而那条路径不受任何挂载策略约束。
- 审计身份 `cellId` 每次运行都是新的。复用容器会让“同一份运行状态”对应多个
  cellId，审计里再也分不清哪次改动是谁做的。

所以持久化的位置只能是宿主。容器仍然是一次性的，历史通过**目录挂载**穿过边界：

| 舱内路径 | 宿主路径 | 权限 | 谁写 |
|---|---|---|---|
| `<cellHome>/.<agentId>` | `<instancesRoot>/<instanceId>/<agentId>` | `rw` | agent 自己 |
| `<cellHome>/.<agentId>/settings.json` | 同上，此文件 | `ro`（嵌套） | abx 每次起舱前重写 |

代价是宿主上多了一份会长期存在的数据，所以它必须过第 5 节那四道闸，
并且以 `0700` 创建。

**舱内 home 必须与挂载点同源。** 历史写到哪由 `HOME` 决定，目录挂在哪由
`session.cellHome` 决定。这两个值一旦分家，agent 会往一个**没被挂载**的路径写历史，
容器一退就没了，而命令行里看不出任何异常。生成配置的路径曾经就踩过这个坑：
配置落到了宿主的 `~/.claude/settings.json`，舱内读的却是 `/home/node/.claude/settings.json`，
「agent 走气闸」在 docker 后端上等于从没生效。现在 `session.cellHome` 是唯一来源，
docker 后端显式注入 `--env HOME=<cellHome>`。

## 2. 为什么按实例，不按舱

`cellId` 和 `instanceId` 是两种身份，混用会同时坏掉审计和体验：

| | `cellId` | `instanceId` |
|---|---|---|
| 含义 | 这一次运行 | 哪一份历史 |
| 谁生成 | abx，每次新生成 | 默认 = agent id，可 `--instance` 指定 |
| 出现位置 | 容器名、标签、审计、`sessions.jsonl` | 实例目录名、`sessions.jsonl` 的 `instanceId` |
| 能否复用 | **绝不** | 应该复用 |

如果按 `cellId` 存历史，每开一次就是一份全新的空目录，“再开一次 claude 接着上次聊”
永远不成立；如果复用 `cellId`，审计里两次运行就再也分不开。两个身份各管一件事，
才能同时成立。

`--instance work` 可以开一份平行历史，与默认的那份互不影响。

## 3. 为什么整目录 `rw`，而不是子路径白名单

agent 的 home 目录结构是它自己的实现细节，而且会随版本变：`projects/`、`todos/`、
`settings.json`、锁文件、将来的缓存目录……列白名单的结果一定是**某天漏掉一个路径，
历史静默地只丢一部分**——这种 bug 不会报错，只在用户发现“上次的会话不见了”时暴露。

所以整个 `<agentId>` 目录以 `rw` 挂进去，保护不靠“目录里没有别的东西”，而靠两层：

1. **abx 生成的配置文件单独一层 `ro` 覆盖**在同一路径上（下一节的实测）；
2. **挂载源本身**必须过第 5 节的四道闸——可挂的目录只能是实例根下面、
   形状正确、解析软链后仍不逃逸的那一格。

**绝不挂宿主的 `~/.claude` / `~/.codex` / `~/.dsh`。** 那些目录里有真实凭据文件和
别家端点；实例目录由 abx 创建，初始为空。

## 4. 嵌套只读：实测结果

保护的实现是「同一个路径挂两次」：目录 `rw`，目录里的 `settings.json` 再以 `ro`
盖一层。docker 的规则是**更深的目标赢**。实测命令与输出：

```console
$ PROBE="$HOME/.abx-nested-ro-probe"; mkdir -p "$PROBE/claude"
$ printf '{"generated":true}\n' > "$PROBE/claude/settings.json"

$ docker run --rm --read-only --user 1000:1000 --env HOME=/home/node \
    --volume "$PROBE/claude:/home/node/.claude:rw" \
    --volume "$PROBE/claude/settings.json:/home/node/.claude/settings.json:ro" \
    node:22-slim sh -c '
      cat "$HOME/.claude/settings.json"
      printf "tampered\n" >> "$HOME/.claude/settings.json" || echo "SETTINGS-WRITE=DENIED $?"
      printf "sibling\n" > "$HOME/.claude/sibling.txt" && echo "SIBLING-WRITE=OK"'

{"generated":true}
SETTINGS-WRITE=DENIED 2
SIBLING-WRITE=OK
sh: 1: cannot create /home/node/.claude/settings.json: Read-only file system

$ ls -la "$PROBE/claude"; cat "$PROBE/claude/settings.json"
-rw-rw-r-- 1 openclaw openclaw   19 … settings.json
-rw-r--r-- 1 openclaw openclaw    8 … sibling.txt
{"generated":true}
```

结论：

- 配置**读得到、改不动**，拒绝原因正是 `Read-only file system`，不是权限位；
- 同一个目录里的其他文件**照常可写**（`sibling.txt` 落到了宿主上），
  说明 `ro` 只盖住了那一格，没有把整个挂载顶回只读；
- `settings.json` 在宿主上保持原样，舱内的写入没有穿透。

`settings.json` 每次起舱前由 abx 重新生成，所以宿主上那一份即使被改脏，
下一次运行也会被覆盖。

## 5. 安全边界：两类可写挂载与四道闸

`mount-policy.ts` 不再说「只有任务目录可写」，而是**两类**，并且数量写死：

```ts
writableClasses: ['taskDir', 'instanceState']
// 可写挂载上限 = 1 + stateDirs.length
```

多出来的那一类必须逐个过闸；`assertMountPolicy` 在 `docker run` 之前执行，
`open` 在建目录之后、起 broker 之前也会先跑一遍 `assertStateDirPolicy`——**先校验，
再往里写配置**，否则配置可能已经顺着软链写到别处去了。

| 闸门 | 挡住什么 | 例子 |
|---|---|---|
| ① 形状与位置 | 状态目录必须是 `<instancesRoot>/<instanceId>/<agentId>`，目录名与 agentId 一致，舱内目标必须在 `cellHome` 之下 | 把实例目录本身或别的 agent 的目录当挂载源 |
| ② realpath 不逃逸 | 解析软链之后仍在实例根之内；解析失败则**失败关闭** | 实例目录里放一个指向 `/etc` 的软链 |
| ③ 不是宿主 home | 不得等于宿主 home，也不得是它的**祖先** | `ABX_INSTANCES_ROOT=/home` 或 `=$HOME` |
| ④ 不碰凭据 | 目录名不得命中凭据文件黑名单，挂载形态必须是目录 | 拿一个叫 `.credentials.json` 的路径当状态目录 |

另外，`ABX_INSTANCES_ROOT` 自己也要过检查：禁止 `/`、`/etc/...`、相对路径、
`..`，以及 `.ssh` / `.gnupg` / `.aws` / `.config` / `.kube` / `.docker` /
`.claude` / `.codex` / `.dsh` 这些子目录——否则 `~/.ssh/instances` 这种写法会
把整个 `.ssh` 变成“实例根”，闸门 ① 反而认为它合法。

最该记住的两条回归测试（`mount-policy.test.ts`）：

- 拿宿主真实的 `~/.claude` 当状态目录源 → 拒绝（`不在实例根`）；
- 把 `ABX_INSTANCES_ROOT` 指到 `/home` 或宿主 home → 拒绝（`宿主 home`）。

**abx 自己的记账也不进舱。** `sessions.jsonl` 写在 `<instancesRoot>/<instanceId>/`，
比挂载点高一层，所以容器里看不到它；每次运行追加一行（`cellId`、`agentId`、
起止时间、退出码、信号）。

## 6. 代码落点

| 文件 | 职责 |
|---|---|
| `packages/contracts/source/config.ts` | `session.cellHome`（默认 `/home/node`），舱内 home 的唯一来源 |
| `packages/core/source/session/instance.ts` | `planInstance` / `ensureInstanceStateDir` / `appendSessionRecord` / `defaultInstancesRoot` |
| `packages/core/source/session/mount-policy.ts` | 两类可写挂载、四道闸、`ABX_INSTANCES_ROOT` 检查 |
| `packages/core/source/session/agent-config.ts` | 生成的配置落进实例目录，再以嵌套 `ro` 挂载 |
| `packages/core/source/session/docker-backend.ts` | `--env HOME=<cellHome>`、`--volume` 顺序、`--tty` 条件分配 |
| `packages/core/source/commands/open.ts` | `--instance`、闸门调用、`sessions.jsonl` 追加 |
| `packages/toolkit/scripts/e2e-persist.sh` | 真 docker 验证：写历史 → 销毁 → 同一实例读回 |

真 docker 的验证结论与原始输出以 `e2e-persist.sh` 的实际运行结果为准；
进度与验收状态见 [`../../roadmap.md`](../../roadmap.md)。
