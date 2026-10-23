#!/usr/bin/env bash
#
# 本地构建 agent 镜像：**按 agent id 构建一个**。
#
# 为什么需要它：一个裸的 `node:22-slim` 里没有 `claude`、也没有 `codex`。不构建一个
# 自带 agent 的镜像，docker 后端能起的就只有「一个空壳容器」，真实验证只验得到
# 「舱内连得上气闸」，验不到「agent 真的在舱里干活」。
#
# 这个脚本不认任何具体 agent：镜像名、版本、舱内命令**一律从注册表读**
# （`packages/contracts/source/agents.ts`，经由 `lib/agent-registry.mjs`），
# 而 Dockerfile 按约定住在 `images/agents/<agent-id>/Dockerfile`、构建上下文就是
# 那个目录。三个 agent 的镜像定义因此是同构的：加一个 agent 就多一个目录，
# 脚本不用改，也不会多出一份「某个 agent 的例外」。
#
# 只做本地：不推远端、不签名（见 `images/agents/<agent-id>/README.md` 的「明确不做」）。
#
# 用法：
#   bash packages/toolkit/scripts/build-agent-image.sh <agent-id>
#
# **一次只构建一个，不传 id 就什么都不建**：构建哪个镜像是显式选择，不是「跑一下
# 脚本顺手把三个都拉一遍」。没给 id（或给了不认识的 id）时打印可选的 agent 列表，
# 以 2 退出——工具不该替用户猜。
#
# 退出码：0 = 镜像已在本地；1 = 构建失败 / docker 不可用 / 这个 agent 还没有镜像定义；
#         2 = 用法不对（没给 id、id 不在注册表里）。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

AGENT_REGISTRY="packages/toolkit/scripts/lib/agent-registry.mjs"
REGISTRY_FILE="packages/contracts/source/agents.ts"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
run()  { printf '  \033[2m$'; printf ' %s' "$@"; printf '\033[0m\n'; }
raw()  { printf '    %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; }

# ── 0. 构建哪个 agent ────────────────────────────────────────────────────
# id 的校验直接交给注册表：它自己就会说「注册表里没有 agent X，当前有 …」。
# 脚本里再写一份 id 名单，就是第二张 agent 表——那张表不会跟着新 agent 长。
step '0. 构建哪个 agent'

AGENT_ID="${1:-}"
if [ -z "$AGENT_ID" ]; then
  fail '没有指定 agent id。'
  raw '用法：bash packages/toolkit/scripts/build-agent-image.sh <agent-id>'
  raw "可选的 agent：$(node "$AGENT_REGISTRY" --ids | tr '\n' ' ' | sed 's/ $//')"
  raw '一次只构建一个：不传 id 就什么都不建。'
  exit 2
fi

if ! AGENT_VERSION="$(node "$AGENT_REGISTRY" "$AGENT_ID" version)"; then
  printf '\n'
  fail "构建哪个 agent 要看注册表，而它不认识 ${AGENT_ID}（上面那行是它的原话）。"
  raw '用法：bash packages/toolkit/scripts/build-agent-image.sh <agent-id>'
  exit 2
fi

DOCKERFILE="images/agents/${AGENT_ID}/Dockerfile"
CONTEXT="images/agents/${AGENT_ID}"
IMAGE_REPO="$(node "$AGENT_REGISTRY" "$AGENT_ID" repository)"
AGENT_COMMAND="$(node "$AGENT_REGISTRY" "$AGENT_ID" command)"
LOCAL_TAG="${IMAGE_REPO}:local"

if [ -z "$IMAGE_REPO" ] || [ -z "$AGENT_COMMAND" ]; then
  fail "从注册表里读不到 ${AGENT_ID} 的 image.repository / command。"
  raw "注册表：$REGISTRY_FILE（经由 $AGENT_REGISTRY）"
  exit 1
fi

ok "要构建的是 ${AGENT_ID}：${IMAGE_REPO}，舱内命令 ${AGENT_COMMAND}"

# ── 1. 这个 agent 有镜像定义吗 ───────────────────────────────────────────
# 两道闸，报的是两件不同的事：
#   - 版本是 unbuilt → 注册表说「还没有镜像」，那不是一个可以构建的目标；
#   - 没有 Dockerfile  → 版本钉住了，但没人写镜像定义。
# 两种都**非零退出**，而且都要说清下一步该动哪个文件：这是构建脚本，
# 悄悄以 0 退出会让人以为镜像已经在了。
step '1. 这个 agent 有镜像定义吗'

if [ "$AGENT_VERSION" = 'unbuilt' ]; then
  fail "注册表里 ${AGENT_ID} 的 image.version 是 unbuilt：这是一个「还没有镜像」的标记，不是一个可构建的目标。"
  raw "先把版本钉住：$REGISTRY_FILE 里 ${AGENT_ID} 的 image.version 改成实际装得上的那个版本。"
  raw "钉之前先确认 $DOCKERFILE 存在——没有 Dockerfile 时钉一个版本只是编了个号。"
  exit 1
fi

if [ ! -f "$DOCKERFILE" ]; then
  fail "找不到 $DOCKERFILE"
  raw "注册表里 ${AGENT_ID} 钉的是 $AGENT_VERSION，但镜像定义不在约定的位置。"
  raw "要加一个 agent 的镜像，就在 images/agents/${AGENT_ID}/ 下放一个 Dockerfile（照现有那份的纪律写）。"
  exit 1
fi

# 版本要真的传进 Dockerfile：ARG 没有默认值之后，只靠 `docker build` 直接调用
# 会装到一个空版本并当场失败。三个 agent 的 Dockerfile 用**同一个** ARG 名，
# 于是这个检查与上面那些一样，跟具体 agent 无关。
if ! grep -qE '^ARG AGENT_VERSION' "$DOCKERFILE"; then
  fail "$DOCKERFILE 里没有 ARG AGENT_VERSION，构建脚本传的版本不会起作用"
  exit 1
fi

raw "注册表给的镜像：$IMAGE_REPO"
raw "注册表钉的版本：$AGENT_VERSION"
ok "要构建：$IMAGE_REPO:$AGENT_VERSION（另有本地标签 $LOCAL_TAG）"

# ── 2. docker 可用吗 ──────────────────────────────────────────────────────
# 放在「有没有镜像定义」之后：定义错了（unbuilt / 没有 Dockerfile）是**先**该知道的事，
# 它跟这台机器上有没有 docker 无关，也不该因为 docker 没起就报不出来。
#
# 这里「docker 不可用」必须**非零退出**：这是个构建脚本，它唯一的作用就是产出镜像。
# 悄悄以 0 退出会让人以为镜像已经在了（`e2e-docker.sh` 那种验证脚本才适合「没验 = 通过」）。
step '2. docker 可用吗'

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

# ── 3. 构建 ───────────────────────────────────────────────────────────────
step '3. 构建镜像'

IID_FILE="$(mktemp "${TMPDIR:-/tmp}/abx-agent-image-iid-XXXXXX")"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/abx-agent-image-build-XXXXXX.log")"

BUILD_ARGS=(
  build
  --file "$DOCKERFILE"
  --build-arg "AGENT_VERSION=$AGENT_VERSION"
  --tag "$LOCAL_TAG"
  --tag "$IMAGE_REPO:$AGENT_VERSION"
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

# 构建期自检（镜像里那条命令的 `--version` 必须是钉住的那个版本）写在各自的
# Dockerfile 里：输出格式是**逐个 agent 实测出来的**，只有 Dockerfile 知道怎么解析。
# 这里只确认那段自检还在，**不**从日志里刮版本号：层命中缓存时 BuildKit 打的是
# RUN 命令的原文，按关键字刮到的是命令本身而不是输出，刮出来的东西没法看，
# 而「版本对不对」第 5 步会拿标签指向的那份镜像直接验一遍。
if ! grep -q '构建自检失败' "$DOCKERFILE"; then
  fail "$DOCKERFILE 里的构建期版本自检没了——装不上/装错版本就不会再让构建失败了。"
  raw "完整日志：$BUILD_LOG"
  rm -f "$IID_FILE"
  exit 1
fi
ok 'Dockerfile 里的构建期版本自检在位'

rm -f "$BUILD_LOG"

# ── 4. 打出来的标签与 digest ──────────────────────────────────────────────
# 本地构建出来的镜像没有 RepoDigests（那是推过 registry 才有的东西），
# 所以这里报的是 image ID —— 它就是本地这份镜像的 config digest，
# 是「两个镜像是不是同一份东西」在本地唯一可比的值。
step '4. 产物'

if [ ! -s "$IID_FILE" ]; then
  fail '构建成功但没拿到 iid 文件，报不出 digest。'
  exit 1
fi
IMAGE_ID="$(cat "$IID_FILE")"
rm -f "$IID_FILE"

raw "标签    $LOCAL_TAG"
raw "标签    $IMAGE_REPO:$AGENT_VERSION"
raw "digest  $IMAGE_ID"
raw "大小    $(docker image inspect --format '{{.Size}}' "$LOCAL_TAG" | awk '{printf "%.1f MiB\n", $1/1048576}')"
raw "构建于  $(docker image inspect --format '{{.Created}}' "$LOCAL_TAG")"

# ── 5. 打完再验一次：标签指向的那份镜像真的跑得起来 ────────────────────────
# Dockerfile 里那次自检发生在构建阶段；这一步验的是**打上标签之后**的那份，
# 而且用的是注册表里那条命令——命令名写错的话，这里就发现了。
#
# 断言只要求输出里**出现**钉住的版本，不解析具体格式：格式是每个 agent 自己的事
# （claude 打 `2.1.308 (Claude Code)`，codex 打 `codex-cli 0.164.0`），
# 严格解析在各自的 Dockerfile 里、紧挨着那条实测出来的格式。
step "5. 冒烟：标签指向的镜像里 ${AGENT_COMMAND} 能跑"

SMOKE="$(docker run --rm "$LOCAL_TAG" "$AGENT_COMMAND" --version 2>&1)"
if [ $? != 0 ]; then
  fail "docker run --rm $LOCAL_TAG $AGENT_COMMAND --version 失败：$SMOKE"
  exit 1
fi
raw "docker run --rm $LOCAL_TAG $AGENT_COMMAND --version -> $SMOKE"
case "$SMOKE" in
  *"$AGENT_VERSION"*) ok "镜像里的 $AGENT_COMMAND 报的版本里有 $AGENT_VERSION" ;;
  *) fail "镜像里 $AGENT_COMMAND --version 的输出里没有 $AGENT_VERSION：$SMOKE" ; exit 1 ;;
esac

# ── 6. 仓库里不留东西 ────────────────────────────────────────────────────
# 构建产物全进 docker 的镜像库；本脚本自己的临时文件（iid / 构建日志）都落在 $TMPDIR。
# 唯一可能把东西带进仓库的路径是**构建上下文里有别的文件**（docker 会把上下文整个
# 传给守护进程，落在那儿的产物迟早会被 `ADD`/`COPY` 带进镜像）。
# 所以这里直接数上下文里的文件：只该有 Dockerfile 和 README.md。
step '6. 构建上下文里有什么'
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
E2E_SCRIPT="packages/toolkit/scripts/e2e-agent-${AGENT_ID}.sh"
if [ -f "$E2E_SCRIPT" ]; then
  printf '  e2e 用它跑一次真 agent：bash %s\n' "$E2E_SCRIPT"
else
  printf '  （还没有 %s：这个 agent 的真 e2e 尚未写）\n' "$E2E_SCRIPT"
fi
exit 0
