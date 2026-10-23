# `abx-agent-claude` —— 带 claude 的舱内镜像

一个裸的 `node:22-slim` 里**没有** `claude` 这条命令。三个 agent 清单里的
`command` 分别是 `claude` / `codex` / `dsh`，而镜像现在也按 agent 给
（`session.image` 不写时用的就是清单里那个）；镜像不对，docker 后端能起的
只是一个空壳容器：真实验证只验得到「舱内连得上气闸」，验不到「agent 真的在舱里干活」。

这个镜像补的就是那一样东西：**一个能跑的 `claude` 命令**。别的什么都不是。

## 为什么一个 agent 一个目录

`images/agents/<agentId>/` 与清单里的「一个 agent 一条命令」对齐
（`packages/contracts/source/agents.ts` 的 `AGENT_DEFINITIONS`）。
三个 agent 的供应链、版本、启动约束各不相同：

- 合成一个「什么都有」的镜像，等于把三家的依赖树叠在一起，
  于是「舱里到底装了什么」变成一句说不清的话——而这句话正是这套东西要能答上来的；
- 一个 agent 要升版本 / 要自检 / 要换基础镜像时，改动范围就是一个目录；
- 将来按 agent 收窄网络白名单、按 agent 做镜像扫描，也都有了一个天然的边界。

`codex` / `dsh` 将来各自在 `images/agents/` 下开一个同构的目录，不复用这里的 Dockerfile。

## 里面有什么

| | |
|---|---|
| 基础镜像 | `node:22-slim` |
| 装的是什么 | `npm install -g @anthropic-ai/claude-code@<钉住的版本>` |
| 入口 | 没有 `ENTRYPOINT`，`CMD` 也不设——命令由 abx 拼（`claude -p '...'`） |
| 用户 | 镜像里是 root 装的包；**跑的时候**由 abx 指定 `--user 1000:1000`（镜像自带的 `node` 用户） |

## 为什么钉死版本

版本号只写在注册表里：`packages/contracts/source/agents.ts` 中 claude 的
`image.version`（当前是 **`2.1.308`**）。构建脚本从那儿读，再用
`--build-arg AGENT_VERSION=...` 传给 Dockerfile；Dockerfile 里的 `ARG`
刻意没有默认值，所以「注册表说一个版本、Dockerfile 里是另一个」这种不一致
不会发生。这个 arg 的名字三个 agent 用同一个，构建脚本因此不用维护
「哪个 agent 用哪个 arg 名」的表。

- 宿主上跑的 claude 是原生安装的 `2.1.308`。镜像里这份是 npm 全局包。
  两边同版本，「镜像里跑出来的行为和宿主不一样」就少了一个变量。
- 不用 `latest`：某天 `docker build` 顺手拉上来一个新版本，
  表现出来会是「昨天还能跑、今天 agent 的行为变了」，而没有任何一处改动能解释它。
  升版本是一次显式改动，看得见 diff。

构建期会自检 `claude --version`：装不上、跑不起来、装到了别的版本，
**构建直接失败**——不然问题推迟到舱内才暴露，而那时的表现（「agent 起不来」）
和「气闸没配好」长得一模一样。

## 怎么本地构建

```bash
bash packages/toolkit/scripts/build-agent-image.sh claude
```

构建哪个 agent 要显式给 id（不传就什么都不建，只列出可选项）。
打出两个标签：`abx-agent-claude:local` 和 `abx-agent-claude:<版本>`。
脚本用的是 `node:22-slim` 的默认 npm registry（`https://registry.npmjs.org/`），
不受宿主那份镜像源配置影响。

单跑一下容器里的 claude，不需要 abx：

```bash
docker run --rm abx-agent-claude:local claude --version
# 2.1.308 (Claude Code)
```

要跑一次真 agent，见 `packages/toolkit/scripts/e2e-agent-claude.sh`。

## 明确不包含什么

这个清单是有意的——**镜像里多一样东西，舱内就多一个能碰到的东西**：

- **没有凭据。** 没有 API key、没有 token、没有 `.credentials.json`、
  没有 OAuth 登录态、没有 `~/.claude/settings.json`。
  舱内 agent 拿到的 baseUrl 指向气闸舱面，token 是占位符，真密钥只存在于宿主上
  气闸进程的内存里（见 `packages/core/source/broker/credentials.ts`）。
  **镜像不需要任何凭据就能构建、能启动、能被验证。**
- **没有配置。** 配置由 abx 现生成、逐个文件只读挂载（见
  `apps/docs/specs/overview/agent-config.md`）。镜像里预置一份配置只会变成
  「第二处真相」，外加一坨会随版本腐烂的默认值。
- **没有历史。** 没有 `~/.claude/projects`、没有会话记录、没有 shell history。
  容器是 `--rm` 的一次性容器，镜像里再带一份历史就等于跨会话残留。
- **没有 SSH。** 没有 `sshd`、没有 `~/.ssh`、没有 known_hosts。
  有了它们，舱内 agent 就能以你的身份用你的私钥，而私钥文件一个字节都不用挂进去。
- **没有 docker CLI。** 有它等于把宿主的 docker socket 变成了舱内的可选项，
  而那是一条直接的逃逸路径。
- **没有授权签名、没有 cosign、不推任何远端 registry。** 这个镜像只服务本地验证，
  供应链那一层等产品形态定下来再说。

## 已知约束（实测，不是猜测）

- **`$HOME` 在 `--read-only` 下不可写。** abx 的 docker 后端按
  `--read-only` + `--tmpfs /tmp` 起容器，`--user 1000:1000` 对应的
  `HOME=/home/node` 是只读的（实测：`touch $HOME/.claude.json` →
  `Read-only file system`）。`claude -p` 在这个条件下能跑通，
  但任何要往 `$HOME` 落状态的路径都会失败。
  「持久化目录到底要覆盖哪些路径」由另一条线决定，这里只记录现象，
  **不靠改 flag 绕过去**——那样验的就不是 abx 的真实约束了。
- 反过来，镜像**不**为这个约束做任何预置（不预建可写目录、不设 `HOME`），
  理由同上：镜像是「一个能跑的 agent 命令」，不是对沙箱参数的补偿。

## 在 abx 的 flag 下跑它，会先撞上三件跟镜像无关的事（实测）

三条都不是这个镜像的问题，但都会让人以为「镜像不对」，所以写在这儿：

- **`--interactive --tty` 要求 docker 客户端自己的 stdin 是终端。**
  `buildDockerArgs` 里这两个 flag 是写死的（终端里的 `abx open` 需要它们），
  而 docker 客户端在 stdin 不是终端时直接拒绝，容器根本起不来：

  ```
  cannot attach stdin to a TTY-enabled container because stdin is not a terminal
  ```

  也就是说「非交互地起一个舱」这条路今天走不通。要跑就给它一个终端
  （`script -qec "<命令>" /dev/null`）——`e2e-agent-claude.sh` 就是这么做的，
  安全相关的 flag 一个都没动。
- **被挂进舱的路径必须是 docker 共享的宿主路径。** Docker Desktop 只共享一部分
  （这台机器上实测只有 `$HOME` 下的路径；把 `/tmp` 下的目录挂进去会被拒：
  `mounts denied: The path /tmp/... is not shared from the host`）。
  任务目录和 abx 生成的那份配置都在挂载清单里，所以跑 e2e 时的临时目录要落在能共享的地方。
- **带 `-t` 的容器，输出流里会混进两个字符 `^@`**（`0x5E 0x40`，两个可打印字符，
  **不是** NUL 字节；`script` 不会这么转义，是 docker 客户端自己写的）。
  实测同一个镜像 + 同一套 flag：`sh -c 'echo A'` 的输出是 `^@A`，
  而另一次容器的输出里一个都没有 —— 位置不固定，所以读容器输出时不能假设第一行干净。
  这件事在 abx 这边有真实后果：舱内探测「哪条地址能到舱面」读的就是容器输出的第一行，
  那次 `^@` 正好粘在它前面，通告地址被读成 `^@host.docker.internal`，
  注入舱内的 `ANTHROPIC_BASE_URL` 成了 `http://^@host.docker.internal:28889/u/anthropic`。
  能打通纯属侥幸：URL 语法把开头的 `^` 当成了 userinfo（用户名），host 碰巧还是对的。
  `e2e-agent-claude.sh` 现在把这两个字符洗掉，并且用严格的主机名字符集去认那条探测结果
  —— 宁可当场失败，也不把一个带杂质的字符串当成主机名注入舱内。
