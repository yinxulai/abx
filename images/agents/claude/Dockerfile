# abx 的 agent 镜像：claude。
#
# 一个 agent 一个目录：清单里 `claude` / `codex` / `dsh` 各是独立的一条命令，
# 各自的依赖、版本、自检也各不相同。合并成一个「什么都有」的镜像，等于把三个
# agent 的供应链叠在一起，也让「舱里到底装了什么」变成一句说不清的话。
#
# 这个镜像只提供一样东西：**一个能跑的 `claude` 命令**。
# 凭据、配置、历史、SSH、docker CLI 一律不在里面 —— 见同目录的 README.md。

FROM node:22-slim

# 版本钉死，不用 latest。**版本号只写在注册表里**
# （`packages/contracts/source/agents.ts` 中 claude 的 `image.version`），
# 由 `build-agent-image.sh` 用 `--build-arg` 传进来。这里刻意不给默认值：
# 两份默认值迟早会漂，而「标签说 2.1.308、里面其实是别的版本」几乎查不出来。
# 直接 `docker build` 而不传这个 arg 会装到一个空版本并当场失败——这是有意的。
#
# ARG 的名字三个 agent 用同一个（`AGENT_VERSION`），构建脚本才不必维护一张
# 「哪个 agent 用哪个 arg 名」的表。改这个名字要连 build-agent-image.sh 一起改。
#
# 镜像里这份是 npm 全局包，让它的版本与注册表里那个值一致，
# 「镜像里跑出来的行为和预期不一样」就少了一个变量。
#
# 注意：`node:22-slim` 的默认 npm registry 是 https://registry.npmjs.org/，
# 不受宿主那份镜像源配置影响。
ARG AGENT_VERSION

RUN npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${AGENT_VERSION}" \
  && npm cache clean --force \
  && rm -rf /root/.npm

# 构建期自检：`claude --version` 必须能跑、而且必须是钉住的那个版本。
#
# 装不上、装上了跑不起来、装到了别的版本，三种情况都在这里让**构建失败**——
# 否则问题会推迟到舱内才暴露，那时的表现是「agent 起不来」，
# 而这和「气闸没配好」长得一模一样，很难归因。
RUN set -eu; \
  actual="$(claude --version)"; \
  printf 'claude --version -> %s\n' "$actual"; \
  test "$(printf '%s' "$actual" | cut -d' ' -f1)" = "${AGENT_VERSION}" || { \
    printf '构建自检失败：期望 %s，实际 %s\n' "${AGENT_VERSION}" "$actual" >&2; \
    exit 1; \
  }
