# abx 的 agent 镜像：codex。
#
# 一个 agent 一个目录：清单里 `claude` / `codex` / `dsh` 各是独立的一条命令，
# 各自的依赖、版本、自检也各不相同。合并成一个「什么都有」的镜像，等于把三个
# agent 的供应链叠在一起，也让「舱里到底装了什么」变成一句说不清的话。
#
# 这个镜像只提供一样东西：**一个能跑的 `codex` 命令**。
# 凭据、配置、历史、SSH、docker CLI 一律不在里面 —— 见同目录的 README.md。

FROM node:22-slim

# 版本钉死，不用 latest。**版本号只写在注册表里**
# （`packages/contracts/source/agents.ts` 中 codex 的 `image.version`），
# 由 `build-agent-image.sh` 用 `--build-arg` 传进来。这里刻意不给默认值：
# 两份默认值迟早会漂，而「标签说 0.164.0、里面其实是别的版本」几乎查不出来。
# 直接 `docker build` 而不传这个 arg 会装到一个空版本并当场失败——这是有意的。
#
# ARG 的名字三个 agent 用同一个（`AGENT_VERSION`），构建脚本才不必维护一张
# 「哪个 agent 用哪个 arg 名」的表。改这个名字要连 build-agent-image.sh 一起改。
#
# 注意：`node:22-slim` 的默认 npm registry 是 https://registry.npmjs.org/，
# 不受宿主那份镜像源配置影响。
ARG AGENT_VERSION

# 包名与版本都来自 npm，`bin/codex.js` 是包装脚本，真正的可执行文件由同版本号的
# `@openai/codex-linux-*` 之类平台包带进来（npm 按平台选一个，随主包装上）。
RUN npm install --global --no-fund --no-audit "@openai/codex@${AGENT_VERSION}" \
  && npm cache clean --force \
  && rm -rf /root/.npm

# 构建期自检：`codex --version` 必须能跑、而且必须是钉住的那个版本。
#
# 装不上、装上了跑不起来、装到了别的版本，三种情况都在这里让**构建失败**——
# 否则问题会推迟到舱内才暴露，那时的表现是「agent 起不来」，
# 而这和「气闸没配好」长得一模一样，很难归因。
#
# 解析方式是**实测出来的**，不是照 claude 那份改的：
#   $ docker run --rm <这个镜像> codex --version
#   codex-cli 0.164.0
# 单行、stdout、`<名字> <版本>` 两段——版本在**第二段**（claude 是版本在前、
# 后面还挂一个括号后缀，两份格式不同）。所以这里断言三件事：只有一行、
# 第一段是 `codex-cli`、第二段正好是钉住的版本。名字那一段也一起钉住是有意的：
# 上游哪天改了输出形状，构建当场失败并把这行原话打出来，
# 而不是等到舱内再让人猜「这行东西是什么」。
#
# 取的是 stdout（`$(...)` 只收 stdout）：codex 在写不了 `$HOME` 的时候会往
# **stderr** 打一行 PATH alias 的警告（实测于 abx 的 `--read-only` 条件下），
# 那行警告与版本无关，不该影响这里的判断。
#
# 自检自己必须**无残留**，因为这一层跑出来的东西会留在镜像里。实测：不隔离地跑
# 一次 `codex --version`，它会在 `$HOME` 下建出 `~/.codex/tmp/arg0-linux/<一坨>`
# ——它靠这个目录造 PATH 别名。这份残留留在镜像里的后果有两个，都不是小事：
#   - `~/.codex` 是 codex **自己的状态目录**，而「镜像里没有配置、没有历史」
#     正是这个镜像的纪律；
#   - 下一次运行会把上一份判成 stale，于是**每一次**运行都先往 stderr 打一行
#     `WARNING: failed to clean up stale arg0 temp dirs`——而 abx 的舱内探测
#     读的正是容器输出的第一行。
# 所以自检跑在一次性的 HOME / TMPDIR 里，跑完连目录一起删掉：不列「要删哪几个
# 文件」（那份名单会随版本腐烂），而是让它压根写不到镜像里去。
#
# （镜像 `/tmp` 里那个 `node-compile-cache` 是 npm 自己留下的，与这里的自检无关；
#   abx 起容器时用 `--tmpfs /tmp` 盖住整个 `/tmp`，舱内看不到它。）
RUN set -eu; \
  home="$(mktemp -d)"; \
  tmp="$(mktemp -d)"; \
  actual="$(HOME="$home" TMPDIR="$tmp" codex --version)"; \
  printf 'codex --version -> %s\n' "$actual"; \
  lines="$(printf '%s\n' "$actual" | wc -l | tr -d ' ')"; \
  name="$(printf '%s' "$actual" | cut -d' ' -f1)"; \
  version="$(printf '%s' "$actual" | cut -d' ' -f2)"; \
  if [ "$lines" != '1' ] || [ "$name" != 'codex-cli' ] || [ "$version" != "${AGENT_VERSION}" ]; then \
    printf '构建自检失败：期望 codex --version 打出单行 "codex-cli %s"，实际是 %s（%s 行）\n' \
      "${AGENT_VERSION}" "$actual" "$lines" >&2; \
    exit 1; \
  fi; \
  rm -rf "$home" "$tmp"
