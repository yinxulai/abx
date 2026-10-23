#!/usr/bin/env bash
#
# 本地构建 agent 镜像（目前只有 claude）。
#
# 为什么需要它：一个裸的 `node:22-slim` 里**没有** `claude` 这条命令。不构建一个
# 自带 agent 的镜像，docker 后端能起的就只有「一个空壳容器」，真实验证只验得到
# 「舱内连得上气闸」，验不到「agent 真的在舱里干活」。
#
# 镜像名与版本**只从注册表读**（`packages/contracts/source/agents.ts` 里 claude 的
# `image`）：这是同一个值的唯一来源，构建脚本里不再写第二份。
#
# 只做本地：不推远端、不签名（见 images/agents/claude/README.md 的「明确不做」）。
#
# 用法：
#   bash packages/toolkit/scripts/build-agent-image.sh
#
# 退出码：0 = 镜像已在本地；1 = 构建失败或 docker 不可用（不会静默跳过）。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

AGENT_REGISTRY="packages/toolkit/scripts/lib/agent-registry.mjs"
DOCKERFILE="images/agents/claude/Dockerfile"
CONTEXT="images/agents/claude"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
run()  { printf '  \033[2m$'; printf ' %s' "$@"; printf '\033[0m\n'; }
raw()  { printf '    %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; }

# ── 0. docker 可用吗 ──────────────────────────────────────────────────────
# 这里「docker 不可用」必须**非零退出**：这是个构建脚本，它唯一的作用就是产出镜像。
# 悄悄以 0 退出会让人以为镜像已经在了（`e2e-docker.sh` 那种验证脚本才适合「没验 = 通过」）。
step '0. docker 可用吗'

if ! command -v docker >/dev/null 2>&1; then
  fail 'docker 命令不在 PATH 上，镜像构建不了。'
  raw '装上 docker 后重跑本脚本；macOS 上需要 Docker Desktop。'
  exit 1
fi

DOCKER_SERVER="$(docker info --format '{{.ServerVersion}}' 2>&1)"
if [ $? != 0 ]; then
  fail 'docker 客户端在，但连不上守护进程，镜像构建不了。'
  raw "守护进程的原话：$(printf '%s' "$DOCKER_SERVER" | head -3 | tr '\n' ' ')"
  printf '\n'
  raw '怎么起（macOS / Docker Desktop）：'
  raw '  systemctl --user start docker-desktop   # 用户级即可，不需要 sudo'
  raw '  或者直接打开 Docker Desktop 应用，等托盘图标变成运行中'
  exit 1
fi
ok "docker 守护进程可用（server $DOCKER_SERVER）"

# ── 1. 镜像名与版本从注册表读，不在这里再写一份 ────────────────────────────
# 两处各写一个版本号，早晚会只改到其中一处；那时镜像是 A、标签是 B，
# 而「标签说 2.1.308、里面其实是 2.1.309」正是最难查的那种不一致。
step '1. 从注册表读要构建的镜像与版本'

if [ ! -f "$DOCKERFILE" ]; then
  fail "找不到 $DOCKERFILE"
  exit 1
fi

IMAGE_REPO="$(node "$AGENT_REGISTRY" claude repository)"
CLAUDE_CODE_VERSION="$(node "$AGENT_REGISTRY" claude version)"
if [ -z "$IMAGE_REPO" ] || [ -z "$CLAUDE_CODE_VERSION" ]; then
  fail '从注册表里读不到 claude 的 image.repository / image.version。'
  raw "注册表：packages/contracts/source/agents.ts（经由 $AGENT_REGISTRY）"
  exit 1
fi
if [ "$CLAUDE_CODE_VERSION" = "unbuilt" ]; then
  fail '注册表里 claude 的 image.version 是 unbuilt：先把版本钉住（见 agents.ts 的注释）。'
  exit 1
fi

# 版本要真的传进 Dockerfile：ARG 没有默认值之后，只靠 `docker build` 直接调用
# 会装到一个空版本。这里确认那一行还在。
if ! grep -qE '^ARG CLAUDE_CODE_VERSION' "$DOCKERFILE"; then
  fail "$DOCKERFILE 里没有 ARG CLAUDE_CODE_VERSION，构建脚本传的版本不会起作用"
  exit 1
fi

LOCAL_TAG="${IMAGE_REPO}:local"
raw "注册表给的镜像：$IMAGE_REPO"
raw "注册表钉的版本：$CLAUDE_CODE_VERSION"
ok "要构建：$IMAGE_REPO:$CLAUDE_CODE_VERSION（另有本地标签 $LOCAL_TAG）"

# ── 2. 构建 ───────────────────────────────────────────────────────────────
step '2. 构建镜像'

IID_FILE="$(mktemp "${TMPDIR:-/tmp}/abx-agent-image-iid-XXXXXX")"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/abx-agent-image-build-XXXXXX.log")"

BUILD_ARGS=(
  build
  --file "$DOCKERFILE"
  --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION"
  --tag "$LOCAL_TAG"
  --tag "$IMAGE_REPO:$CLAUDE_CODE_VERSION"
  --iidfile "$IID_FILE"
  "$CONTEXT"
)

run docker "${BUILD_ARGS[@]}"
if ! docker "${BUILD_ARGS[@]}" 2>&1 | tee "$BUILD_LOG"; then
  fail '构建失败。docker build 的原话在上面。'
  raw "完整日志：$BUILD_LOG"
  rm -f "$IID_FILE"
  exit 1
fi

# 构建期自检（`claude --version` 必须打印出钉住的版本）写在 Dockerfile 里。
# 这里只确认那一层还在，**不**从日志里刮版本号：层命中缓存时 BuildKit 打的是
# RUN 命令的原文，按关键字刮到的是命令本身而不是输出，刮出来的东西没法看，
# 而「版本对不对」第 4 步会拿标签指向的那份镜像直接验一遍。
if ! grep -q '构建自检失败' "$DOCKERFILE"; then
  fail "$DOCKERFILE 里的构建期版本自检没了——装不上/装错版本就不会再让构建失败了。"
  raw "完整日志：$BUILD_LOG"
  rm -f "$IID_FILE"
  exit 1
fi
ok 'Dockerfile 里的构建期版本自检在位'

rm -f "$BUILD_LOG"

# ── 3. 打出来的标签与 digest ──────────────────────────────────────────────
# 本地构建出来的镜像没有 RepoDigests（那是推过 registry 才有的东西），
# 所以这里报的是 image ID —— 它就是本地这份镜像的 config digest，
# 是「两个镜像是不是同一份东西」在本地唯一可比的值。
step '3. 产物'

if [ ! -s "$IID_FILE" ]; then
  fail '构建成功但没拿到 iid 文件，报不出 digest。'
  exit 1
fi
IMAGE_ID="$(cat "$IID_FILE")"
rm -f "$IID_FILE"

raw "标签    $LOCAL_TAG"
raw "标签    $IMAGE_REPO:$CLAUDE_CODE_VERSION"
raw "digest  $IMAGE_ID"
raw "大小    $(docker image inspect --format '{{.Size}}' "$LOCAL_TAG" | awk '{printf "%.1f MiB\n", $1/1048576}')"
raw "构建于  $(docker image inspect --format '{{.Created}}' "$LOCAL_TAG")"

# ── 4. 打完再验一次：标签指向的那份镜像真的跑得起来 ────────────────────────
# Dockerfile 里那次自检发生在构建阶段；这一步验的是**打上标签之后**的那份。
step '4. 冒烟：标签指向的镜像里 claude 能跑'

SMOKE="$(docker run --rm "$LOCAL_TAG" claude --version 2>&1)"
if [ $? != 0 ]; then
  fail "docker run --rm $LOCAL_TAG claude --version 失败：$SMOKE"
  exit 1
fi
raw "docker run --rm $LOCAL_TAG claude --version -> $SMOKE"
case "$SMOKE" in
  "$CLAUDE_CODE_VERSION"*) ok "镜像里的 claude 是 $CLAUDE_CODE_VERSION" ;;
  *) fail "镜像里的 claude 版本不是 $CLAUDE_CODE_VERSION：$SMOKE" ; exit 1 ;;
esac

# ── 5. 仓库里不留东西 ────────────────────────────────────────────────────
# 构建产物全进 docker 的镜像库；本脚本自己的临时文件（iid / 构建日志）都落在 $TMPDIR。
# 唯一可能把东西带进仓库的路径是**构建上下文里有别的文件**（docker 会把上下文整个
# 传给守护进程，落在那儿的产物迟早会被 `ADD`/`COPY` 带进镜像）。
# 所以这里直接数上下文里的文件：只该有 Dockerfile 和 README.md。
step '5. 构建上下文里有什么'
CONTEXT_FILES="$(find "$CONTEXT" -type f | sort)"
printf '%s\n' "$CONTEXT_FILES" | while read -r file; do raw "${file#"$CONTEXT"/}"; done

UNEXPECTED="$(printf '%s\n' "$CONTEXT_FILES" | grep -vE "^$CONTEXT/(Dockerfile|README\.md)$" || true)"
if [ -z "$UNEXPECTED" ]; then
  ok "构建上下文只有 Dockerfile 与 README.md，没有构建产物"
else
  printf '  \033[33m⚠ 构建上下文里有预期之外的文件，确认一下是不是构建产物：\033[0m\n'
  printf '%s\n' "$UNEXPECTED" | while read -r line; do raw "$line"; done
fi
raw '（镜像在 docker 的镜像库里；本脚本的临时文件在 $TMPDIR，仓库里不落东西）'

printf '\n\033[1m=== 结论 ===\033[0m\n'
printf '  镜像已就绪：%s（%s）\n' "$LOCAL_TAG" "$IMAGE_ID"
printf '  e2e 用它跑一次真 agent：bash packages/toolkit/scripts/e2e-agent-claude.sh\n'
exit 0
