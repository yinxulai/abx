#!/usr/bin/env bash
#
# Abx 传递窗真实验证：**舱内的 agent 把一个真文件递给宿主，宿主打开它。**
#
# 为什么需要它：单测里 broker、shim、账本全都有替身，没有一条用例跨过容器边界。
# 而这件事的每一条承诺都在边界上——「舱内那个文件的 sha256 与交付格里那一份相同」
# 「白名单之外的类型只显示不打开」「打开动作不经过 shell」——只有真起一个容器、
# 真的让舱内那个进程去发请求，才算验过。
#
# 三处东西是真的，都不许换成替身：
#   1. 容器 —— 参数由 core 的 `createDockerBackend` 拼（挂载清单来自 `MOUNT_POLICY`，
#      策略检查照跑），命令这一格换成了下面那个驱动脚本，理由见第 4 步；
#   2. 传递窗 —— 宿主侧是 `createTransomRuntime`（真交付格、真账本），舱内侧是
#      真挂进去的那个 `abx-mcp-shim.mjs`，中间是真 HTTP / 真 broker；
#   3. 文件 —— sha256 由**舱内**算一遍、宿主上再算一遍，两边比对。
#
# 唯一的替身是「打开文件」那条命令：`xdg-open` 换成了一个记账用的脚本
# （`$WORK/bin/xdg-open`）。理由与 `opener.ts` 里那条一致：真实现会弹窗，
# 而脚本里不能弹窗。这一换反而多验了一条——那个脚本把收到的 argv 一行一个记下来，
# 于是「文件名没有被拼进一条 shell 命令」这件事**是看得见的**：
# 名字里带 `$(...)` 的那个文件原样出现在一个 argv 里，而它想干的坏事没有发生。
#
# 凭据纪律：全程没有真凭据。配置里只有环境变量名，密钥值都是 `FAKE-` 开头的假值。
#
# 用法：
#   bash packages/toolkit/scripts/e2e-transom.sh            # 跑全部
#   bash packages/toolkit/scripts/e2e-transom.sh --keep     # 跑完不清理临时目录
#
# 退出码：0 = 硬断言全过（docker 不可用也走这条，并说明原因）；
#         1 = 有硬断言没过。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# 临时目录不落在 /tmp：容器要把它挂进去，而 Docker Desktop 只共享宿主上的一部分路径
# （理由与 e2e-agent-claude.sh 同一段）。默认落在 $HOME 下，可用 ABX_E2E_WORK_BASE 覆盖。
WORK_BASE="${ABX_E2E_WORK_BASE:-${XDG_CACHE_HOME:-$HOME/.cache}/abx-e2e}"
mkdir -p "$WORK_BASE"
WORK="$(mktemp -d "$WORK_BASE/transom-XXXXXX")"

FAILED=0
OPEN_PID=""
CELL_CONTAINER=""

cleanup() {
  [ -n "$CELL_CONTAINER" ] && docker rm -f "$CELL_CONTAINER" >/dev/null 2>&1
  if [ -n "$OPEN_PID" ]; then
    kill "$OPEN_PID" 2>/dev/null
    wait "$OPEN_PID" 2>/dev/null
  fi
  if [ "$KEEP" = "1" ]; then
    printf '\n临时目录保留在 %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
run()  { printf '  \033[2m$ %s\033[0m\n' "$1"; }
raw()  { printf '    %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
note() { printf '  \033[33m·\033[0m %s\n' "$1"; }

# ── 0. docker 可用吗 ──────────────────────────────────────────────────────
# 「不可用」不是失败：这台机器上没装 / 没起 docker，不应该表现成验证不通过。
# 但也**不许**表现成验证通过 —— 所以这里明确说「没验」，然后以 0 退出。
step '0. docker 可用吗'

if ! command -v docker >/dev/null 2>&1; then
  printf '  docker 命令不在 PATH 上，\033[33m这次没有验证任何东西\033[0m。\n'
  printf '  装上 docker 后重跑本脚本；macOS 上需要 Docker Desktop。\n'
  exit 0
fi

DOCKER_SERVER="$(docker info --format '{{.ServerVersion}}' 2>&1)"
if [ "$?" != "0" ]; then
  printf '  docker 客户端在，但连不上守护进程，\033[33m这次没有验证任何东西\033[0m。\n'
  printf '  守护进程的原话：%s\n' "$(printf '%s' "$DOCKER_SERVER" | head -3 | tr '\n' ' ')"
  exit 0
fi
ok "docker 守护进程可用（server $DOCKER_SERVER）"

# 用 agent 的镜像，不用裸镜像：这一条要验的正是「agent 那个容器里多了什么」。
# 镜像名与版本只有注册表一个来源（`packages/contracts/source/agents.ts`），
# 脚本里不重写一遍——工具链的 lint 也会拦这个。
AGENT_REGISTRY="packages/toolkit/scripts/lib/agent-registry.mjs"
IMAGE="${ABX_E2E_IMAGE:-$(node "$AGENT_REGISTRY" claude ref)}"
run "docker image inspect $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf '  本机没有 %s，\033[33m这次没有验证任何东西\033[0m。\n' "$IMAGE"
  printf '  先构建它：bash packages/toolkit/scripts/build-agent-image.sh claude\n'
  printf '  （或者用 ABX_E2E_IMAGE=<别的镜像> 指定一个带 node 的镜像。）\n'
  exit 0
fi
ok "镜像 $IMAGE 就绪"

# ── 1. 端口、配置、临时根 ─────────────────────────────────────────────────
# 上一轮跑剩的 broker 还占着这两个端口的话，`abx open` 会**接上它**而不是自己起一个
# （`ensureBroker` 看到端口有人听就不动它），而那种会话的传递窗是不可用的。
# 于是这一次的断言验的会是别人的进程——比失败更坏，所以先挡一道。
step '1. 端口、配置、临时根'

HOST_PORT="${ABX_E2E_HOST_PORT:-28793}"
CELL_PORT="${ABX_E2E_CELL_PORT:-28794}"
for port in "$HOST_PORT" "$CELL_PORT"; do
  if curl -sS -o /dev/null --max-time 1 "http://127.0.0.1:$port/healthz" 2>/dev/null; then
    printf '端口 %s 上已经有东西在响应（大概是上一轮留下的 broker）。先停掉它再跑本脚本。\n' "$port"
    printf '查是谁占着：ss -ltnp | grep %s\n' "$port"
    exit 1
  fi
done
ok "端口 $HOST_PORT / $CELL_PORT 都是空的（不会被「接上别人的 broker」骗过去）"

CELL_USER="$(id -u):$(id -g)"
TASK="$WORK/task"
# 实例状态目录必须长在实例根下面——这是 `assertStateDirPolicy` 那道闸的规矩
# （「宿主上现成的目录例如 ~/.claude 不能直接挂进去」），形状与 `abx open` 一致。
STATE="$WORK/instances/claude/claude"
mkdir -p "$TASK" "$STATE" "$WORK/bin"

# 传递窗那几个根全部落到临时目录：跑一次验证不该在开发者真实的 `~/.abx` 里留东西。
export ABX_INSTANCES_ROOT="$WORK/instances"
export ABX_RUNTIME_ROOT="$WORK/runtime"
export ABX_OUTBOX_ROOT="$WORK/outbox"
export ABX_TRANSOM_LEDGER="$WORK/transom.jsonl"
export ABX_E2E_WORK="$WORK"
export ABX_E2E_TASK="$TASK"
export ABX_E2E_STATE="$STATE"
export ABX_E2E_HOST_PORT="$HOST_PORT"
export ABX_E2E_CELL_PORT="$CELL_PORT"
export ABX_E2E_USER="$CELL_USER"
export ABX_E2E_IMAGE="$IMAGE"
export ABX_E2E_FAKE_SECRET='FAKE-SECRET-e2e-transom-0000-not-a-real-key'
export ABX_CELL_TOKEN='abx_cell_e2e-transom-7c41d2'

CONFIG="$WORK/abx.config.json"
cat > "$CONFIG" <<EOF
{
  "broker": {
    "hostPort": $HOST_PORT,
    "cellHost": "0.0.0.0",
    "cellPort": $CELL_PORT,
    "cellTokenEnv": "ABX_CELL_TOKEN",
    "allowCellTokenInPath": true,
    "auditPath": "$WORK/audit.jsonl",
    "requestTimeoutMs": 10000
  },
  "egress": { "allow": [{ "pattern": "127.0.0.1", "upstreamId": "anthropic" }] },
  "upstreams": [
    { "id": "anthropic", "baseUrl": "http://127.0.0.1:29921", "authHeader": "authorization",
      "authScheme": "Bearer", "secretEnv": "ABX_E2E_FAKE_SECRET" }
  ],
  "session": { "backend": "docker", "user": "$CELL_USER", "image": "$IMAGE" }
}
EOF

# `cellHost` 显式写 0.0.0.0，理由与 e2e-docker.sh 第 1 步那段一样：这台机器上
# 默认的 172.17.0.1 **绑不上**（docker 的网桥在另一个网络命名空间里，`ip addr` 里
# 根本没有 docker0；doctor 对 172.17.0.1 也正是这么警告的）。写 0.0.0.0 是把
# broker 绑到所有网卡上，容器才够得着。代价是生成给 agent 的 baseUrl 也会写成
# 0.0.0.0——所以「舱内真的用这个地址连上了」这件事不在第 3 步验，第 4 步用
# 一个容器里解析得出的地址（host.docker.internal）来验。

# 「打开文件」那条命令的替身。它把收到的每个 argv 单独记一行 ——
# 这正是「文件名没有被拼进 shell 命令」的取证方式（见文件头）。
cat > "$WORK/bin/xdg-open" <<'EOF'
#!/usr/bin/env bash
printf 'argv-count=%s\n' "$#" >> "$ABX_E2E_OPEN_LOG"
for arg in "$@"; do printf 'argv=%s\n' "$arg" >> "$ABX_E2E_OPEN_LOG"; done
EOF
chmod +x "$WORK/bin/xdg-open"
export ABX_E2E_OPEN_LOG="$WORK/opened.log"
export PATH="$WORK/bin:$PATH"

# core 是 TS 源码，入口之间用无扩展名 import（`from './audit'`），node 的 ESM 解析器
# 不认。这里给 node 挂一个十几行的解析钩子，只做「补 .ts / 补 /index.ts」。
# 与 e2e-docker.sh / e2e-local.sh 同一套做法，没有新增任何依赖。
cat > "$WORK/ts-resolve.mjs" <<'EOF'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/') ? specifier : fileURLToPath(new URL(specifier, context.parentURL))
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(candidate)) return next(candidate, context)
      }
    }
    throw error
  }
}
EOF

cat > "$WORK/register.mjs" <<'EOF'
import { register } from 'node:module'
register('./ts-resolve.mjs', import.meta.url)
EOF

# 极小的 argv 适配器：只认本脚本用到的 `open`，不是命令行产品。
cat > "$WORK/driver.mjs" <<'EOF'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const coreDir = process.env.ABX_CORE_DIR
const load = async (name) => import(pathToFileURL(path.join(coreDir, `${name}.ts`)).href)
// `host-platform.ts` 住在 `source/` 根下，不在 `commands/` 里，所以另配一个往上一层找的
// 加载器（`load()` 认的是命令层那一格）。
const coreRoot = path.join(coreDir, '..')
const loadCore = async (name) => import(pathToFileURL(path.join(coreRoot, `${name}.ts`)).href)
const { resolveContext } = await load('runtime')
const { requireHostPlatform } = await loadCore('host-platform')
const { runOpen } = await load('open')

const argv = process.argv.slice(2)
// 本脚本只调 `open` 这一个子命令，所以「命令名」这一格固定剥掉。
if (argv[0] === 'open') argv.shift()
const options = {
  positionals: [],
  configPath: null,
  backend: null,
  json: false,
  tail: false,
  dryRun: false,
  instance: null,
  cellHost: null,
  tokenFile: null,
}
while (argv.length > 0) {
  const arg = argv.shift()
  if (arg === '--config') options.configPath = argv.shift()
  else if (arg === '--dry-run') options.dryRun = true
  else options.positionals.push(arg)
}

const log = (message) => process.stdout.write(`${message}\n`)
// 宿主平台由**宿主层**读一次再传下去（见 core 的 `host-platform.ts`）：core 不自己去读
// `process.platform`，所以这个夹具得像产品入口那样读一次。产品里那一处是 `apps/app`，
// 这里是它的等价物——与 `e2e-local.sh` / `e2e-persist.sh` / `e2e-shared.sh` 同一套写法。
process.exitCode = await runOpen({
  options,
  context: resolveContext({
    cwd: process.cwd(),
    env: process.env,
    configPath: options.configPath,
    platform: requireHostPlatform(process.platform),
  }),
  log,
})
EOF
export ABX_CORE_DIR="$REPO/packages/core/source/commands"

ok "配置、任务目录、临时根都落在 $WORK（真实 ~/.abx 一个字节都不碰）"

# ── 2. 干跑：这次会话会往舱里挂什么 ───────────────────────────────────────
step '2. abx open --dry-run：计划里有没有传递窗那两行'

run "node --import register.mjs driver.mjs open claude task --config abx.config.json --dry-run"
node --import "$WORK/register.mjs" "$WORK/driver.mjs" open claude "$TASK" --config "$CONFIG" --dry-run > "$WORK/plan.log" 2>&1
PLAN_CODE=$?
while IFS= read -r line; do raw "$line"; done < "$WORK/plan.log"

[ "$PLAN_CODE" = "0" ] && ok '干跑正常退出' || fail "干跑退出码 $PLAN_CODE"

SHIM_LINE="$(grep '传递窗 shim' "$WORK/plan.log" || true)"
[ -n "$SHIM_LINE" ] && ok '计划里报了 shim 的挂载（宿主文件 → 舱内固定路径，只读）' || fail '计划里没有 shim 的挂载'
grep -q '交付格' "$WORK/plan.log" && ok '计划里报了交付格（publish 出来的东西落到哪儿）' || fail '计划里没有交付格'

if [ -e "$ABX_RUNTIME_ROOT" ]; then
  fail '干跑竟然建了运行时目录'
else
  ok '干跑报的是路径、不是既成事实（运行时目录没有被创建）'
fi

# 计划里那个**舱内**路径就是下面容器里要执行的那个文件。从这里取，免得两处各写一份。
SHIM_CELL_PATH="$(printf '%s' "$SHIM_LINE" | sed -n 's/.*→ \([^ ]*\)（只读.*/\1/p')"
if [ -n "$SHIM_CELL_PATH" ]; then
  ok "shim 的舱内路径：$SHIM_CELL_PATH"
else
  fail "没能从计划里取出 shim 的舱内路径：$SHIM_LINE"
  SHIM_CELL_PATH='/usr/local/lib/abx/abx-mcp-shim.mjs'
fi
export ABX_E2E_SHIM_PATH="$SHIM_CELL_PATH"

# ── 3. 真起一次 abx open：真容器、真生成的配置、真落盘的 shim ────────────
step '3. 真起一次 abx open claude（真容器、真镜像）'

# claude 在这台机器上没有可用的上游凭据（配置里那个上游是本机一个不存在的端口），
# 所以它起来之后会去连、连不上、然后退出。**这不是这次要验的东西**，
# 所以下面不对它的退出码做断言，只看宿主这一侧留下的痕迹。
#
# stdin 接一个我们持有写端的 FIFO：claude 是交互式 REPL，stdin 一结束它也就结束了。
mkfifo "$WORK/stdin.fifo"
run "node --import register.mjs driver.mjs open claude task --config abx.config.json"
node --import "$WORK/register.mjs" "$WORK/driver.mjs" open claude "$TASK" --config "$CONFIG" \
  < "$WORK/stdin.fifo" > "$WORK/open.log" 2>&1 &
OPEN_PID=$!
exec 9> "$WORK/stdin.fifo"

CELL_ID=""
for _ in $(seq 1 200); do
  CELL_ID="$(sed -n 's/^\[abx\] 会话 \([^ ]*\).*$/\1/p' "$WORK/open.log" | head -1)"
  [ -n "$CELL_ID" ] && break
  kill -0 "$OPEN_PID" 2>/dev/null || break
  sleep 0.1
done

while IFS= read -r line; do raw "$line"; done < "$WORK/open.log"

if [ -z "$CELL_ID" ]; then
  fail 'abx open 没有报出会话 id（先看上面那段原话）'
else
  ok "会话起来了：$CELL_ID"
  grep -q '传递窗 .* → .*（只读' "$WORK/open.log" \
    && ok '会话日志里报了 shim 的只读挂载' || fail '会话日志里没有 shim 的挂载那一行'
  if grep -q '交付格' "$WORK/open.log" && grep -q '交付流水' "$WORK/open.log"; then
    ok '会话日志里报了交付格与交付流水的位置'
  else
    fail '会话日志里没有交付格 / 交付流水'
  fi
fi

# shim 真的落盘了吗（staging 的产物）。干跑那次与这一次的会话 id 必然不同
# （它是每次新生成的审计身份），所以路径要用**这一次**的 id 拼，不能抄计划里的。
SHIM_HOST_PATH="$ABX_RUNTIME_ROOT/$CELL_ID/abx-mcp-shim.mjs"
if [ -n "$SHIM_HOST_PATH" ] && [ -f "$SHIM_HOST_PATH" ]; then
  ok "shim 落盘了：$SHIM_HOST_PATH（$(wc -c < "$SHIM_HOST_PATH" | tr -d ' ') 字节）"
else
  fail "shim 没落盘：${SHIM_HOST_PATH:-（计划里没解析出路径）}"
fi

# 生成的配置里有没有 MCP 注册。它落在实例状态目录里，**不进**宿主 home。
GENERATED_CONFIG="$(find "$ABX_INSTANCES_ROOT" -name '.claude.json' 2>/dev/null | head -1)"
if [ -n "$GENERATED_CONFIG" ]; then
  raw "生成的配置：$GENERATED_CONFIG"
  while IFS= read -r line; do raw "$line"; done < "$GENERATED_CONFIG"
  if grep -q '"mcpServers"' "$GENERATED_CONFIG" && grep -q "$SHIM_CELL_PATH" "$GENERATED_CONFIG"; then
    ok '生成的配置里把传递窗注册成了 MCP 服务，指向舱内那个固定路径'
  else
    fail '生成的配置里没有 MCP 注册'
  fi
  if grep -Eqi 'token|secret|api[_-]?key' "$GENERATED_CONFIG"; then
    fail '生成的配置里出现了像凭据的东西'
  else
    ok '生成的配置里没有任何凭据字样（只有端点与占位符）'
  fi
else
  fail "实例目录里没有 .claude.json（$ABX_INSTANCES_ROOT）"
fi

# 容器在不在。claude 可能因为连不上上游而立刻退出，所以这一条只报告、不判失败；
# 「容器里真的跑起了舱内那个 shim」由第 4 步用确定性的命令来证。
for _ in $(seq 1 50); do
  CELL_CONTAINER="$(docker ps -q --filter "label=abx.cell-id=$CELL_ID" | head -1)"
  [ -n "$CELL_CONTAINER" ] && break
  kill -0 "$OPEN_PID" 2>/dev/null || break
  sleep 0.1
done
if [ -n "$CELL_CONTAINER" ]; then
  ok "真容器起起来了：$CELL_CONTAINER（带 shim 的只读挂载）"
  docker kill "$CELL_CONTAINER" >/dev/null 2>&1
  docker rm -f "$CELL_CONTAINER" >/dev/null 2>&1
  CELL_CONTAINER=""
else
  note '这次容器没能保持存活（claude 没有可用上游时会立刻退出）——容器里的证据看第 4 步'
fi

# 等这次 open 收尾：它退出之后端口才会空出来，第 4 步才能起自己的 broker。
exec 9>&-
for _ in $(seq 1 100); do
  kill -0 "$OPEN_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$OPEN_PID" 2>/dev/null; then
  kill "$OPEN_PID" 2>/dev/null
  wait "$OPEN_PID" 2>/dev/null
fi
OPEN_PID=""
ok '会话收尾了（broker 与传递窗都已关闭，端口空出来了）'

# ── 4. 舱内整条 MCP 流程 ─────────────────────────────────────────────────
# 上一步的容器里跑的是 claude 的 REPL，没法从外面把一串 MCP 消息喂进去。
# 所以这一步的容器**其余部分完全一样**（挂载清单、env、用户、网络、限额都来自 core），
# 只有「跑哪条命令」这一格换成了下面那个驱动脚本。这个替换是明说的：
# 要验的是传递窗那条链路，而不是 claude 会不会主动用它。
step '4. 舱内整条 MCP 流程（真容器 + 真 shim + 真 broker + 真宿主打开）'

# 舱内那个驱动脚本。它在容器里写文件、算 sha256、起 shim、发一串 JSON-RPC。
cat > "$TASK/cell-driver.mjs" <<'EOF'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { symlinkSync, truncateSync, writeFileSync } from 'node:fs'

const SHIM = process.env.ABX_E2E_SHIM_PATH
const DIR = '/workspace'

// 真文件。png 的前八个字节是真的 PNG 签名，后面跟一段可辨认的内容。
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('abx-transom-e2e\n'),
])
writeFileSync(`${DIR}/report.png`, png)
writeFileSync(`${DIR}/setup.sh`, '#!/bin/sh\necho hi\n')
writeFileSync(`${DIR}/noext`, 'no extension\n')
// 网页也能跑脚本：用系统浏览器打开它，等于让舱内写出来的东西在宿主上执行。
writeFileSync(`${DIR}/report.html`, '<!doctype html><title>x</title><script>document.title=1</script>\n')
// 名字里带 shell 元字符：如果打开动作是拼字符串，`touch pwned` 就会在宿主上跑起来。
writeFileSync(`${DIR}/pwn$(touch pwned).pdf`, '%PDF-1.4 fake\n')
// 超限：65 MiB，比 64 MiB 的上限多一点点。
// 先落一个字节再 truncate：node 的 truncateSync 不像 truncate(1)，它不建文件。
writeFileSync(`${DIR}/huge.pdf`, '')
truncateSync(`${DIR}/huge.pdf`, 65 * 1024 * 1024)
// 软链指向舱外。
symlinkSync('/etc/passwd', `${DIR}/leak.pdf`)

console.log(`IN-CELL-SHA256 ${createHash('sha256').update(png).digest('hex')}`)
console.log(`IN-CELL-BYTES ${png.length}`)

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const requests = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'abx-e2e-cell', version: '0.0.0' },
    },
  },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  call(3, 'publish', { path: '/workspace/report.png' }),
  call(4, 'publish', { path: '/workspace/setup.sh' }),
  call(5, 'publish', { path: '/workspace/noext' }),
  call(6, 'publish', { path: '/workspace/pwn$(touch pwned).pdf' }),
  call(7, 'publish', { path: '/etc/passwd' }),
  call(8, 'publish', { path: '/workspace/leak.pdf' }),
  call(9, 'publish', { path: '/workspace/huge.pdf' }),
  call(10, 'open', { name: 'report.png' }),
  call(11, 'publish', { path: '/workspace/report.html' }),
]

const child = spawn(process.execPath, [SHIM], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Set(requests.map((request) => request.id))
let buffer = ''
let settled = false
let finish

const done = new Promise((resolve) => {
  finish = resolve
})
const timeout = setTimeout(() => {
  console.log(`IN-CELL-ERROR 等回复超时，还差 ${[...pending].join(',')}`)
  finish()
}, 20000)

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line === '') continue
    console.log(`REPLY ${line}`)
    try {
      const message = JSON.parse(line)
      pending.delete(message.id)
    } catch {
      // 不是 JSON 的行已经在上面原样打出来了，这里不额外判断。
    }
    if (pending.size === 0 && !settled) {
      settled = true
      finish()
    }
  }
})
child.on('exit', (code) => {
  if (pending.size > 0) console.log(`IN-CELL-ERROR shim 退出了（${code}），还差 ${[...pending].join(',')}`)
  finish()
})

for (const request of requests) {
  console.log(`REQUEST ${JSON.stringify(request)}`)
  child.stdin.write(`${JSON.stringify(request)}\n`)
}

await done
clearTimeout(timeout)
child.stdin.end()
child.kill()
EOF

# 宿主这一侧：真 broker（带真交付格与真账本）+ 两个真容器。
# 断言都在这里做完，逐条打印 CHECK 行，shell 只负责数失败。
cat > "$WORK/host-driver.mjs" <<'EOF'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.env.ABX_REPO
const load = async (relative) => import(pathToFileURL(path.join(REPO, relative)).href)
const { MCP_SHIM_CELL_PATH, findAgent } = await load('packages/contracts/source/index.ts')
const { startBroker } = await load('packages/core/source/broker/index.ts')
const { createTransomRuntime } = await load('packages/core/source/commands/runtime.ts')
const { requireHostPlatform } = await load('packages/core/source/host-platform.ts')
const { createDockerBackend, buildCellEnv, stageAgentConfig, toSandboxConfigFiles } = await load(
  'packages/core/source/session/index.ts',
)
const { defaultRuntimeRoot, runtimeDirFor, stageTransomShim } = await load(
  'packages/core/source/transom/shim.ts',
)
const { outboxDirFor } = await load('packages/core/source/transom/outbox.ts')

const WORK = process.env.ABX_E2E_WORK
const taskDir = process.env.ABX_E2E_TASK
const stateDir = process.env.ABX_E2E_STATE
const hostPort = Number(process.env.ABX_E2E_HOST_PORT)
const cellPort = Number(process.env.ABX_E2E_CELL_PORT)
const user = process.env.ABX_E2E_USER
const image = process.env.ABX_E2E_IMAGE
const cellId = 'claude-e2e-transom-cell'
const agent = findAgent('claude')
const say = (line) => process.stdout.write(`${line}\n`)

let failures = 0
const check = (condition, label, detail = '') => {
  if (!condition) failures += 1
  say(`CHECK ${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const PROBE_JS = `
const url = process.env.PROBE_URL
try {
  // 不带令牌请求 /healthz 会被拒（401）——那也是**连上了**的证据：
  // 这里判的是「有没有收到 HTTP 回复」，不是「那个回复是不是 200」。
  const response = await fetch(url)
  console.log('PROBE ' + process.env.PROBE_HOST + ' ok ' + response.status)
  process.exit(0)
} catch (error) {
  console.log('PROBE ' + process.env.PROBE_HOST + ' fail ' + error.message)
  process.exit(1)
}
`

const config = {
  broker: {
    host: '127.0.0.1',
    hostPort,
    // 舱面绑 0.0.0.0：容器要能从网桥那边连上它，而那个地址由下面的探测决定。
    cellHost: '0.0.0.0',
    cellPort,
    cellTokenEnv: 'ABX_CELL_TOKEN',
    allowCellTokenInPath: true,
    auditPath: path.join(WORK, 'audit.jsonl'),
    requestTimeoutMs: 10000,
  },
  egress: [{ pattern: '127.0.0.1', upstreamId: 'anthropic' }],
  upstreams: [
    {
      id: 'anthropic',
      baseUrl: 'http://127.0.0.1:29921',
      authHeader: 'authorization',
      authScheme: 'Bearer',
      secretEnv: 'ABX_E2E_FAKE_SECRET',
    },
  ],
}

const backend = createDockerBackend()
// 宿主平台：core 不自己去读 `process.platform`，见 `packages/core/source/host-platform.ts`。
const platform = requireHostPlatform(process.platform)
const baseSpec = {
  agentId: 'claude',
  platform,
  allocateTty: false,
  taskDir,
  workdir: '/workspace',
  cellHome: '/home/dev',
  env: {},
  forbiddenEnvNames: ['ABX_E2E_FAKE_SECRET'],
  limits: { memory: '2g', pids: 256, cpus: 2 },
  image,
  user,
  network: 'bridge',
  tmpfsSizeMb: 64,
}

async function runContainer(spec, echo) {
  let stdout = ''
  const onChunk = (chunk) => {
    const text = String(chunk)
    stdout += text
    if (echo) for (const line of text.split('\n')) if (line !== '') say(`  ${line}`)
  }
  const session = await backend.create({ ...baseSpec, ...spec }, { mode: 'pipe', onStdout: onChunk, onStderr: onChunk })
  const exit = await session.exit
  return { stdout, code: exit.code === null ? 1 : exit.code }
}

// ① 传递窗在宿主这一侧：真交付格、真账本、真「打开命令」（PATH 上那个替身）。
const transom = createTransomRuntime({ env: process.env })
const handle = await startBroker({ config, env: process.env, transom: transom.handler })
say(`[host] broker 宿主面 ${handle.hostOrigin} 舱面 ${handle.cellOrigin}`)
say(`[host] 交付格根 ${transom.outboxRoot}`)
say(`[host] 交付流水 ${transom.ledgerPath}`)
say(`[host] 打开命令 ${transom.openerName}`)
check(transom.openerName === 'xdg-open', '这次用的「打开」命令就是 PATH 上那个替身', String(transom.openerName))

// ② 容器从哪条路能连上宿主。不照抄任何约定值，探一遍。
let brokerOrigin = null
for (const candidate of ['host.docker.internal', '172.17.0.1']) {
  const probe = await runContainer(
    {
      cellId: 'claude-e2e-transom-probe',
      command: ['node', '--input-type=module', '-e', PROBE_JS],
      env: { PROBE_HOST: candidate, PROBE_URL: `http://${candidate}:${cellPort}/healthz` },
    },
    false,
  )
  const line = probe.stdout.split('\n').find((entry) => entry.startsWith('PROBE '))
  say(`[host] 探测 ${candidate} -> ${line ?? '(没有任何输出)'}`)
  if (probe.code === 0 && line !== undefined && line.startsWith(`PROBE ${candidate} ok `)) {
    brokerOrigin = `http://${candidate}:${cellPort}`
    break
  }
}

if (brokerOrigin === null) {
  check(false, '舱内能连上宿主的舱面', '两条候选一条都不通')
  await handle.close()
  process.exit(1)
}
check(true, '舱内能连上宿主的舱面', brokerOrigin)

// ③ 这次会话的舱身份与挂载：与 `abx open` 走的是同一批函数。
const cellToken = handle.registerCell(cellId, {
  cellId,
  agentId: 'claude',
  roots: [{ cellPath: '/workspace', hostPath: taskDir, kind: 'workdir' }],
})
const shim = stageTransomShim({ directory: runtimeDirFor(defaultRuntimeRoot(process.env), cellId) })
const staged = stageAgentConfig({
  agentId: 'claude',
  directory: stateDir,
  cellOrigin: brokerOrigin,
  upstreamId: 'anthropic',
  cellToken,
  tokenInPath: true,
  cellHome: '/home/dev',
})
const cellEnv = buildCellEnv({
  agent,
  brokerCellOrigin: brokerOrigin,
  cellId,
  cellToken,
  upstreamId: 'anthropic',
  tokenInPath: true,
})
cellEnv.ABX_E2E_SHIM_PATH = MCP_SHIM_CELL_PATH

const common = {
  cellId,
  agentConfigFiles: toSandboxConfigFiles(staged),
  stateDirs: [{ hostPath: stateDir, cellPath: '/home/dev/.claude', agentId: 'claude' }],
  runtimeFiles: [{ hostPath: shim.hostPath, cellPath: MCP_SHIM_CELL_PATH }],
  env: cellEnv,
}

// ④ 第一个容器：舱内的驱动脚本，把整条 MCP 流程走一遍。
say('[host] ── 舱内会话记录（原样）──')
const matrix = await runContainer({ ...common, command: ['node', '/workspace/cell-driver.mjs'] }, false)
for (const line of matrix.stdout.split('\n')) {
  if (line === '') continue
  // 协议那两行原样打（多缩进一格就看不出这是原始的往返记录了），其余的行
  // （包括容器自己的 stderr）缩进打——失败的时候要能看见原话。
  if (line.startsWith('REQUEST ') || line.startsWith('REPLY ') || line.startsWith('IN-CELL-')) say(line)
  else say(`  ${line}`)
}
check(matrix.code === 0, '舱内那一段跑完了', `退出码 ${matrix.code}`)

const replies = new Map()
for (const line of matrix.stdout.split('\n')) {
  if (!line.startsWith('REPLY ')) continue
  const message = JSON.parse(line.slice(6))
  replies.set(message.id, message)
}
const textOf = (id) => {
  const reply = replies.get(id)
  if (reply === undefined) return `<没有回复 id=${id}>`
  if (reply.error !== undefined) return `<JSON-RPC 错误 ${reply.error.code}: ${reply.error.message}>`
  return reply.result.content.map((part) => part.text).join('\n')
}

check(replies.get(1)?.result?.serverInfo?.name === 'abx', 'initialize 回的是传递窗自己')
check(
  JSON.stringify(replies.get(2)?.result?.tools?.map((tool) => tool.name)) === '["publish","open"]',
  'tools/list 就是那两个工具，没有第三个',
)
check(textOf(10).includes('已打开 report.png'), 'open 能打开已经交付过的那一份', textOf(10).trim())

// ⑤ 宿主这一侧：交付格里那一份，与舱内算的 sha256 比对。
const inCellSha = (matrix.stdout.split('\n').find((line) => line.startsWith('IN-CELL-SHA256 ')) ?? '').slice(15).trim()
check(/^[0-9a-f]{64}$/.test(inCellSha), '舱内算出了 sha256', inCellSha)

const delivered = path.join(outboxDirFor(transom.outboxRoot, cellId), 'report.png')
const deliveredBytes = existsSync(delivered) ? readFileSync(delivered) : null
const hostSha = deliveredBytes === null ? '' : createHash('sha256').update(deliveredBytes).digest('hex')
say(`DELIVERED ${delivered}`)
say(`HOST-SHA256 ${hostSha}`)
check(deliveredBytes !== null, '文件真的进了交付格', delivered)
check(hostSha !== '' && hostSha === inCellSha, '舱内 sha256 == 交付格里那一份的 sha256', `${inCellSha} / ${hostSha}`)

// ⑥ 白名单：png 打开、别的只显示。
const openedLog = existsSync(process.env.ABX_E2E_OPEN_LOG)
  ? readFileSync(process.env.ABX_E2E_OPEN_LOG, 'utf8')
  : ''
say('OPENED-LOG')
for (const line of openedLog.trim().split('\n')) if (line !== '') say(`  ${line}`)
check(textOf(3).includes('宿主已经用默认应用打开了它'), '白名单里的 .png：真的被打开了', textOf(3).split('\n')[0])
check(textOf(4).includes('没有自动打开'), '.sh：只显示，不打开', textOf(4).split('\n').pop())
check(textOf(5).includes('没有自动打开'), '没有后缀：只显示，不打开', textOf(5).split('\n').pop())
check(
  textOf(11).includes('能跑脚本') && textOf(11).includes('没有自动打开'),
  '.html：能跑脚本，所以只显示、**绝不**用系统浏览器打开',
  textOf(11).split('\n').find((line) => line.startsWith('没有自动打开')) ?? textOf(11).split('\n')[0],
)
check(
  !openedLog.includes('setup.sh') && !openedLog.includes('/noext') && !openedLog.includes('report.html'),
  '那三个文件一个都没被当作「可打开的东西」传出去',
)

// 「打开不经过 shell」：名字里带 `$(...)` 的那个文件原样出现在**一个** argv 里，
// 而它想干的事（在宿主上建一个 pwned 文件）没有发生。
const oddPath = path.join(outboxDirFor(transom.outboxRoot, cellId), 'pwn$(touch pwned).pdf')
const oddLine = `argv=${oddPath}`
check(openedLog.split('\n').includes(oddLine), '带 shell 元字符的文件名原样出现在一个 argv 里', oddLine)
const canary = path.join(WORK, 'pwned')
check(!existsSync(canary), '它想执行的那条命令没有发生', canary)
check(!openedLog.includes('argv=pwned') && !openedLog.includes('argv=touch'), '没有被拆出额外的 argv')

// ⑦ 三条拒绝，文本原样回给舱内。
check(textOf(7).includes('不在这次会话的舱内目录里'), '舱外路径被拒', textOf(7).split('\n')[0])
check(textOf(8).includes('解析软链之后落在了会话目录之外'), '软链指向舱外被拒', textOf(8).split('\n')[0])
check(textOf(9).includes('超过了单次交付的上限 64.0 MiB'), '超限被拒（且没有被截断）', textOf(9).split('\n')[0])

// ⑧ 账本：每一次交付、每一次打开各一行；被拒绝的也记。
const ledgerText = existsSync(transom.ledgerPath) ? readFileSync(transom.ledgerPath, 'utf8').trim() : ''
const ledger = ledgerText === '' ? [] : ledgerText.split('\n').map((line) => JSON.parse(line))
say(`LEDGER ${transom.ledgerPath}`)
for (const line of ledger) say(`  ${JSON.stringify(line)}`)
check(ledger.length === 9, '账本里一行一件事（5 次交付 + 1 次打开 + 3 次拒绝）', `实际 ${ledger.length} 行`)
check(
  ledger.some((line) => line.action === 'publish' && line.outcome === 'opened' && line.sha256 === inCellSha),
  '账里那一行的 sha256 与舱内算的一致',
)
check(
  ledger.every((line) => line.cellId === cellId && line.agentId === 'claude'),
  '每一行都记得住是哪个会话、哪个 agent',
)
check(
  ledger.filter((line) => line.outcome === 'rejected').length === 3,
  '被拒绝的那三次也记账（审计要回答「它试过什么」）',
)
check(ledger.every((line) => !JSON.stringify(line).includes(cellToken)), '账本里没有舱令牌')

// ⑨ 第二个容器：`claude mcp list` —— MCP 服务在**舱内**注册的证据。
say('[host] ── claude mcp list（在容器里）──')
const mcpList = await runContainer({ ...common, command: ['claude', 'mcp', 'list'] }, true)
say(`CLAUDE-MCP-LIST（退出码 ${mcpList.code}）`)
for (const line of mcpList.stdout.trim().split('\n')) if (line !== '') say(`  ${line}`)
const abxLine = mcpList.stdout.split('\n').find((line) => line.includes('abx'))
check(
  abxLine !== undefined,
  '容器里 `claude mcp list` 认得出 abx 这个服务',
  abxLine?.trim() ?? '(输出里没有 abx)',
)

await handle.close()
say(`SUMMARY failures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
EOF

export ABX_REPO="$REPO"
run "node --import register.mjs host-driver.mjs（工作目录 = 临时目录）"
(
  cd "$WORK" || exit 1
  node --import "$WORK/register.mjs" "$WORK/host-driver.mjs"
) > "$WORK/host.log" 2>&1
DRIVER_CODE=$?
while IFS= read -r line; do raw "$line"; done < "$WORK/host.log"

CHECK_PASS="$(grep -c '^CHECK PASS ' "$WORK/host.log" || true)"
CHECK_FAIL="$(grep -c '^CHECK FAIL ' "$WORK/host.log" || true)"
printf '\n  断言：\033[32m%s 过\033[0m / \033[31m%s 不过\033[0m\n' "$CHECK_PASS" "$CHECK_FAIL"

if [ "$CHECK_FAIL" != "0" ]; then
  fail "$CHECK_FAIL 条断言没过（见上面 CHECK FAIL 那几行）"
elif [ "$DRIVER_CODE" != "0" ]; then
  fail "host-driver 退出码 $DRIVER_CODE"
else
  ok "全部 $CHECK_PASS 条断言都过了"
fi

# ── 5. 没验到的东西 ───────────────────────────────────────────────────────
step '5. 这次没验到的'
note 'macOS / Windows 上的打开命令（这个仓库只在 linux 上跑过；映射表有单测，但没有真机）'
note '真实 claude 会不会主动调用 publish / open（这里验的是「注册了、链路通了、结果对」）'
note 'HTML / SVG：这轮不做预览，它们和 .sh 一样只显示、不打开（见 docs 里的决定）'

if [ "$FAILED" = "0" ]; then
  printf '\n\033[32m传递窗这条链路验过了：舱内的文件递到宿主、sha256 一致、白名单内打开、白名单外只显示。\033[0m\n'
  exit 0
fi

printf '\n\033[31m有硬断言没过。\033[0m\n'
exit 1
