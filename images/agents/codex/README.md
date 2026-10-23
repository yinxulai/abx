# `abx-agent-codex` —— 带 codex 的舱内镜像

一个裸的 `node:22-slim` 里**没有** `codex` 这条命令。镜像内置了它，别的什么都不是。

图形、纪律、目录布局都跟隔壁 `../claude/` 同构（那边的 README 把「为什么一个 agent
一个镜像」「为什么钉死版本」「为什么镜像里不放凭据」讲透了，这里不重复），
差的是**里面装的东西**与**实测出来的输出格式**。

## 里面有什么

| | |
|---|---|
| 基础镜像 | `node:22-slim` |
| 装的是什么 | `npm install -g @openai/codex@<钉住的版本>`（包装脚本 `bin/codex.js` + 平台包 `@openai/codex-linux-x64` 里的原生可执行文件） |
| 入口 | 没有 `ENTRYPOINT`，`CMD` 也不设——命令由 abx 拼 |
| 用户 | 镜像里是 root 装的包；**跑的时候**由 abx 指定 `--user 1000:1000` |
| 大小 | 实测 **673 MB**（`docker images` 那一列；claude 那份是 521 MB——原生二进制比 npm 包重） |

版本号只写在注册表里：`packages/contracts/source/agents.ts` 中 codex 的
`image.version`（当前 **`0.164.0`**）。构建脚本从那儿读，再用
`--build-arg AGENT_VERSION=...` 传给 Dockerfile；Dockerfile 里的 `ARG` 刻意没有
默认值。不用 `latest` 的理由与 claude 那份一样：升版本要是一次看得见 diff 的显式改动。

## 怎么本地构建

```bash
bash packages/toolkit/scripts/build-agent-image.sh codex
```

打出两个标签：`abx-agent-codex:local` 与 `abx-agent-codex:0.164.0`。

## 怎么手工验一次

不需要 abx，两条命令：

```bash
docker run --rm abx-agent-codex:local codex --version
# codex-cli 0.164.0

# 再用 abx 起容器的那套 flag 跑一次（只读根 + 非 root + 实例目录挂在 ~/.codex）。
# 临时目录落在 $HOME 下：Docker Desktop 只共享宿主的某些路径，/tmp 不在其中。
mkdir -p "$HOME/.cache/abx-codex-probe/instance-codex"
docker run --rm --read-only --tmpfs /tmp --user 1000:1000 \
  -v "$HOME/.cache/abx-codex-probe/instance-codex":/home/node/.codex \
  abx-agent-codex:local codex --version
# codex-cli 0.164.0
```

构建期还会自检一次（装不上 / 跑不起来 / 装到了别的版本 → **构建失败**）。
自检的解析方式是**在这个镜像里实测出来的**，不是照 claude 那份改的：

```
$ docker run --rm <这个镜像> codex --version
codex-cli 0.164.0
```

单行、走 stdout、`<名字> <版本>` 两段——版本在**第二段**。而 claude 是版本在前、
后面还挂一个括号后缀（`2.1.308 (Claude Code)`）。两份格式不一样，所以两份
Dockerfile 各自断言各自的形状（codex 这边连 `codex-cli` 这个名字一起钉住：
上游哪天改了输出形状，构建当场失败并把原话打出来，而不是留到舱内让人猜）。

## 明确不包含什么

跟 claude 那份同一张清单：**没有凭据**（没有 `auth.json`、没有 API key、没有
登录态）、**没有配置**、**没有历史**、**没有 SSH**、**没有 docker CLI**、
**不推远端 registry、不签名**。

对 codex 具体一点：

- `~/.codex/config.toml`（abx 现生成、只读挂进去的那份）**不在镜像里**；
- `~/.codex/auth.json`（登录凭据）**不在镜像里**，也永远不进舱；
- 镜像里原来还会被构建期自检写进一个 `~/.codex/tmp/arg0-linux/…`（codex 用它造
  PATH 别名）。已经处理掉：自检跑在一次性的 HOME 里，跑完就删（见 Dockerfile 与
  下面那条「每次运行都会写 `~/.codex`」）。

## 已知约束（实测，不是猜测）

- **每次运行都会往 `~/.codex` 写东西。** codex 启动时在 `~/.codex/tmp/arg0-linux/`
  下开一个目录放 `apply_patch` / `applypatch` / `codex-linux-sandbox` 这几个符号
  链接（它靠这手把子命令挂到 PATH 上）。实测：`$HOME` 不可写时它会退化成一行
  stderr 警告，命令照常跑：

  ```
  WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)
  codex-cli 0.164.0
  ```

  **在 abx 的 flag 下（`--read-only` + `--tmpfs /tmp` + `--user 1000:1000` +
  把实例目录 rw 挂在 `~/.codex`）那条警告不出现**，退出码 0：挂上去的那一格可写，
  别名建得成。写进去的东西跟着实例目录一起持久化——也就是说 `~/.codex/tmp/` 会
  在历史目录里攒下来（实测挂载点里确实出现了 `tmp/arg0-linux/…`）。
  这不是这个镜像该不该预置目录的问题，只是如实记下「它会往那儿写」。
- **自检必须无残留，否则每次运行都带一行警告。** 构建期那次 `codex --version`
  如果直接跑，`~/.codex` 就留在镜像里了；下一次运行把它判成 stale，于是**每一次**
  运行都先往 stderr 打 `WARNING: failed to clean up stale arg0 temp dirs`。
  而 abx 的舱内探测读的正是容器输出的第一行——一行来路不明的 stderr 就能把地址
  读歪（隔壁 claude 的 README 记过一次同类的 `^@` 事故）。
- 镜像里那个 `/tmp/node-compile-cache` 是 npm 留下的，与自检无关；abx 起容器时
  `--tmpfs /tmp` 会把整个 `/tmp` 盖住。

## 还没验的

- **codex 在真网关下能不能干活**：这里验到的只是「命令在、版本对、按 abx 的 flag
  起得来」。真发一次模型请求、穿过气闸落到上游那条链路，本轮没做
  （claude 那边有 `packages/toolkit/scripts/e2e-agent-claude.sh` 的先例，
  codex 还没有对应的脚本）。
- **abx 生成的那份 `~/.codex/config.toml` 是否真的生效**：模板里的
  `model_provider` / `model_providers.*` 字段名来自 OSW 客户端注册表，
  **没有对着真实的 codex 核对过**（注册表里 codex 那一行也照实写着「尚未实测」）。
- **codex 还会连哪些域名**：`egress.allow` 默认拒绝，白名单要补哪几条只能靠实测。
