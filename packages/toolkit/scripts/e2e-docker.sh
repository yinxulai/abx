#!/usr/bin/env bash
#
# Abx 真实 docker 验证：**容器里的舱，能不能真的连上宿主的舱面。**
#
# 为什么需要它：单测里的 broker 起在回环上，没有任何测试跨过容器边界。
# 「舱内能连上舱面」这件事只有真起一个容器才验得了，而它恰恰是整套东西能不能用的前提——
# 连不上就是「气闸一开，agent 什么都干不了」。
#
# 这份脚本和 `e2e-local.sh` 的分工：那个跑整条链路（配置解析 / 会话编排 / 审计），
# 但容器是假的；这个只跑一件事，但容器、网络、地址解析全是真的。
#
# 起的是**真的 broker**（`packages/core/source/broker`），不是替身服务：
# 要验的就是「舱面认不认令牌」，用一个自己写的替身来验等于没验。
# 只有上游是假的——因为要断言的是「上游收到了什么」，真上游不会告诉你。
#
# 脚本不写任何真实凭据：下面的密钥值都是 `FAKE-` 开头的假值。
#
#   bash packages/toolkit/scripts/e2e-docker.sh            # 跑全部
#   bash packages/toolkit/scripts/e2e-docker.sh --keep     # 跑完不清理临时目录
#
# 退出码：0 = 硬断言全过（docker 不可用也走这条，并说明原因）；
#         1 = 某条硬断言没过。规格探针的结果不影响退出码，只打印。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

IMAGE="${ABX_E2E_IMAGE:-node:22-slim}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/abx-e2e-docker-XXXXXX")"
BROKER_PID=""
FAILED=0
GAPS=0

CELL_TOKEN='abx_cell_e2e-docker-2f9c1a'
FAKE_SECRET='FAKE-SECRET-e2e-docker-0000-not-a-real-key'

cleanup() {
  if [ -n "$BROKER_PID" ]; then
    kill "$BROKER_PID" 2>/dev/null
    wait "$BROKER_PID" 2>/dev/null
  fi
  if [ "$KEEP" = "1" ]; then
    printf '\n临时目录保留在 %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

step()  { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
run()   { printf '  \033[2m$ %s\033[0m\n' "$1"; }
raw()   { printf '    %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAILED=1; }
gap()   { printf '  \033[33m⚠ 规格未满足\033[0m %s\n' "$1"; GAPS=$((GAPS + 1)); }

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
  printf '\n  怎么起（macOS / Docker Desktop）：\n'
  printf '    systemctl --user start docker-desktop   # 用户级即可，不需要 sudo\n'
  printf '    或者直接打开 Docker Desktop 应用，等托盘图标变成运行中\n'
  exit 0
fi
ok "docker 守护进程可用（server $DOCKER_SERVER，client $(docker version --format '{{.Client.Version}}' 2>/dev/null))"

run "docker image inspect $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf '  本机没有 %s，正在拉取……\n' "$IMAGE"
  if ! docker pull "$IMAGE" >"$WORK/pull.log" 2>&1; then
    printf '  拉取失败，\033[33m这次没有验证任何东西\033[0m。原话：\n'
    tail -3 "$WORK/pull.log" | while read -r line; do raw "$line"; done
    exit 0
  fi
fi
ok "镜像 $IMAGE 就绪（与 abx.config.json 里 session.image 一致）"

# ── 1. 起真的 broker ──────────────────────────────────────────────────────
step '1. 起真 broker（舱面绑 0.0.0.0），顺带复现 §19.1 的「宿主绑不上网桥地址」'

# broker 是 TS 源码，入口之间用无扩展名 import（`from './audit'`），
# node 的 ESM 解析器不认。vitest 认，所以单测没暴露这个问题。
# 这里给 node 挂一个十几行的解析钩子，只做「补 .ts / 补 /index.ts」。
# 没有新增任何依赖，用的全是 node 内置模块。
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

cat > "$WORK/driver.mjs" <<'EOF'
// 起一个真的 broker + 一个假上游，把端口写进 info 文件给 shell 读。
// 端口用 0 让系统分配：这样脚本可以并行跑，也不会撞上开发时已经占着的 8789。
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const { ABX_CORE_ENTRY, ABX_WORK_DIR, ABX_CELL_TOKEN } = process.env
const { startBroker } = await import(ABX_CORE_ENTRY)

// ① 宿主能不能绑 docker 网桥网关（§19.1 表格第一列）。
const bindBridge = await new Promise((resolve) => {
  const server = createServer()
  server.once('error', (error) => resolve(error.code ?? error.message))
  server.listen(0, '172.17.0.1', () => {
    const address = server.address()
    server.close(() => resolve(`OK port=${address.port}`))
  })
})

// ② 假上游：把收到的请求头原样回显。客户端说自己发了什么不算数，
//    要上游说它收到了什么才算数。
const upstream = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const seen = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      'x-abx-cell-id': request.headers['x-abx-cell-id'] ?? null,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    writeFileSync(`${ABX_WORK_DIR}/upstream-seen.json`, JSON.stringify(seen, null, 2))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(seen, null, 2))
  })
})
const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port))
})

// ③ 真 broker。舱面绑 0.0.0.0 —— 这是 §19.1 修正后的规则 1。
const config = {
  broker: {
    host: '127.0.0.1',
    hostPort: 0,
    cellHost: '0.0.0.0',
    cellPort: 0,
    cellTokenEnv: 'ABX_CELL_TOKEN',
    allowCellTokenInPath: true,
    auditPath: `${ABX_WORK_DIR}/audit.jsonl`,
    requestTimeoutMs: 10000,
  },
  egress: [{ pattern: '127.0.0.1', upstreamId: 'osw' }],
  upstreams: [
    {
      id: 'osw',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      authHeader: 'authorization',
      authScheme: 'Bearer',
      secretEnv: 'ABX_E2E_FAKE_SECRET',
    },
  ],
  session: {
    backend: 'docker',
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    workdir: '/workspace',
    limits: { memory: '2g', pids: 256, cpus: 2 },
    tmpfsSizeMb: 64,
  },
}

const handle = await startBroker({ config, env: process.env, cellToken: ABX_CELL_TOKEN })
const cellPort = Number(new URL(handle.cellOrigin).port)

writeFileSync(
  `${ABX_WORK_DIR}/broker-info.json`,
  JSON.stringify(
    { bindBridge, upstreamPort, hostOrigin: handle.hostOrigin, cellOrigin: handle.cellOrigin, cellPort, cellToken: handle.cellToken },
    null,
    2,
  ),
)
process.stdout.write(`[driver] 就绪 cellPort=${cellPort} upstreamPort=${upstreamPort}\n`)

const shutdown = () => {
  handle.close().then(
    () => process.exit(0),
    () => process.exit(1),
  )
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
EOF

run "node --import $WORK/register.mjs $WORK/driver.mjs"
ABX_CORE_ENTRY="$REPO/packages/core/source/broker/index.ts" \
ABX_WORK_DIR="$WORK" \
ABX_CELL_TOKEN="$CELL_TOKEN" \
ABX_E2E_FAKE_SECRET="$FAKE_SECRET" \
  node --import "$WORK/register.mjs" "$WORK/driver.mjs" >"$WORK/driver.log" 2>&1 &
BROKER_PID=$!

for _ in $(seq 1 100); do
  [ -s "$WORK/broker-info.json" ] && break
  sleep 0.1
done

if [ ! -s "$WORK/broker-info.json" ]; then
  fail 'broker 没起来'
  printf '  driver 的原话：\n'
  cat "$WORK/driver.log" | while read -r line; do raw "$line"; done
  printf '\n'
  exit 1
fi

cat "$WORK/driver.log" | while read -r line; do raw "$line"; done

info() { node -e "process.stdout.write(String(require('$WORK/broker-info.json')['$1']))"; }
CELL_PORT="$(info cellPort)"
UPSTREAM_PORT="$(info upstreamPort)"
BIND_BRIDGE="$(info bindBridge)"

raw "宿主面  $(info hostOrigin)   舱面  $(info cellOrigin)"

run "node -e 'createServer().listen(0, \"172.17.0.1\")'"
raw "结果：$BIND_BRIDGE"
case "$BIND_BRIDGE" in
  OK*)
    ok '§19.1 第一列：宿主上的 172.17.0.1 这次是能绑的（原生 linux docker 的行为）'
    ;;
  *)
    ok "复现 §19.1 第一列：宿主绑不上 172.17.0.1（$BIND_BRIDGE），所以舱面只能绑 0.0.0.0"
    ;;
esac

# ── 舱内发请求的小工具 ────────────────────────────────────────────────────
# node:22-slim 里既没有 curl 也没有 wget，所以用镜像自带的 node 发请求。
# 换成本机有 curl 的镜像时（ABX_E2E_IMAGE=...）优先用 curl —— 少一层解释。
CELL_JS='
const [url, ...rawHeaders] = process.argv.slice(1)
const headers = {}
for (const line of rawHeaders) {
  const at = line.indexOf(":")
  if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
}
const method = process.env.ABX_PROBE_METHOD ?? "GET"
const body = process.env.ABX_PROBE_BODY ?? undefined
try {
  const response = await fetch(url, { method, headers, body, redirect: "manual" })
  const text = (await response.text()).replace(/\s+/g, " ").trim()
  console.log(`HTTP ${response.status} ${text.slice(0, 200)}`)
} catch (error) {
  console.log(`FAIL ${error.cause?.code ?? error.name}: ${error.message}`)
}
'

DOCKER_RUN=(docker run --rm -e ABX_PROBE_METHOD -e ABX_PROBE_BODY "$IMAGE")

# cell_fetch <url> [header...] —— 打印真正发出的命令，再打印真正拿到的结果。
cell_fetch() {
  local url="$1"; shift
  local shown="docker run --rm $IMAGE node --input-type=module -e '<fetch>' $url"
  for header in "$@"; do shown="$shown -H '$header'"; done
  run "$shown"
  if [ "$#" -gt 0 ]; then
    "${DOCKER_RUN[@]}" node --input-type=module -e "$CELL_JS" "$url" "$@" | sed 's/^/    /'
  else
    "${DOCKER_RUN[@]}" node --input-type=module -e "$CELL_JS" "$url" | sed 's/^/    /'
  fi
}

# cell_fetch_code <url> [header...] —— 只要状态码。
cell_fetch_code() {
  local url="$1"; shift
  if [ "$#" -gt 0 ]; then
    "${DOCKER_RUN[@]}" node --input-type=module -e "$CELL_JS" "$url" "$@" | sed -n 's/^HTTP \([0-9]*\).*/\1/p'
  else
    "${DOCKER_RUN[@]}" node --input-type=module -e "$CELL_JS" "$url" | sed -n 's/^HTTP \([0-9]*\).*/\1/p'
  fi
}

cell_check() { # <期望状态码> <说明> <url> [header...]
  local want="$1" label="$2"; shift 2
  local got
  got="$(cell_fetch_code "$@")"
  printf '  %-34s -> HTTP %s（期望 %s）\n' "$label" "${got:-无响应}" "$want"
  [ "$got" = "$want" ] && ok "$label" || fail "$label：拿到 ${got:-无响应}，期望 $want"
}

# ── 2. 舱内探测宿主地址（§19.1 表格复现）──────────────────────────────────
step '2. 舱内探测：三条候选地址，哪条真的通'

ADDRESS_PROBE_JS='
const port = process.argv[1]
const candidates = ["host.docker.internal", "172.17.0.1", "192.168.65.2"]
for (const host of candidates) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: controller.signal })
    clearTimeout(timer)
    console.log(`${host} -> HTTP ${response.status}`)
  } catch (error) {
    console.log(`${host} -> ${error.cause?.code ?? error.name}: ${error.message}`)
  }
}
'

# 先解决「host.docker.internal 这个名字在不在」。Docker Desktop 会注入它，
# 原生 linux docker 不会 —— 没有的话显式补一条映射，那时它指向 docker0 网关。
# 注意**不要无条件加 `--add-host`**：在 Docker Desktop 上它会把这个名字改指到
# 一个 IPv6 ULA 地址（实测 `fdc4:f303:9324::254`），而舱面绑的是纯 IPv4 的 0.0.0.0。
run "docker run --rm $IMAGE getent hosts host.docker.internal"
RAW_RESOLVE="$("${DOCKER_RUN[@]}" sh -c 'getent hosts host.docker.internal || echo "(解析不出来)"')"
raw "结果：$RAW_RESOLVE"
HOST_DOCKER_IP="$(printf '%s' "$RAW_RESOLVE" | awk '/^[0-9]/{print $1; exit}')"
if [ -z "$HOST_DOCKER_IP" ]; then
  DOCKER_RUN+=(--add-host=host.docker.internal:host-gateway)
  raw "解析不出来，已加 --add-host=host.docker.internal:host-gateway 重试"
  RAW_RESOLVE="$("${DOCKER_RUN[@]}" sh -c 'getent hosts host.docker.internal || echo "(还是解析不出来)"')"
  raw "结果：$RAW_RESOLVE"
fi

# 探测三条候选地址。探的是 /healthz 且不带令牌：
#   HTTP 401 = 请求到了舱面（舱面本来就要令牌，401 正是「通了」的证据）
#   ECONNREFUSED / 超时 = 那条路压根没通
run "docker run --rm $IMAGE node -e '<依次尝试 host.docker.internal / 172.17.0.1 / 192.168.65.2>' $CELL_PORT"
raw '（探 /healthz 不带令牌：HTTP 401 = 到了舱面；ECONNREFUSED = 没连上）'
ADDRESS_PROBE_OUT="$("${DOCKER_RUN[@]}" node --input-type=module -e "$ADDRESS_PROBE_JS" "$CELL_PORT")"
printf '%s\n' "$ADDRESS_PROBE_OUT" | while read -r line; do raw "$line"; done

REACH_HOST_DOCKER="$(printf '%s\n' "$ADDRESS_PROBE_OUT" | sed -n 's/^host\.docker\.internal -> \(.*\)$/\1/p')"
REACH_BRIDGE_GW="$(printf '%s\n' "$ADDRESS_PROBE_OUT" | sed -n 's/^172\.17\.0\.1 -> \(.*\)$/\1/p')"
REACH_VM_GATEWAY="$(printf '%s\n' "$ADDRESS_PROBE_OUT" | sed -n 's/^192\.168\.65\.2 -> \(.*\)$/\1/p')"

# 探测结论：按候选表顺序取第一条真的能到舱面的地址。
# 这一步就是「探测后决定」——不照抄任何文档里的约定值。
# core 里目前**没有**这个探测（第 5 步给出落点），所以这里用 shell 实现同一套判定。
CELL_HOST=''
for candidate in host.docker.internal 172.17.0.1 192.168.65.2; do
  case "$ADDRESS_PROBE_OUT" in
    *"$candidate -> HTTP "*) CELL_HOST="$candidate"; break ;;
  esac
done

if [ -z "$CELL_HOST" ]; then
  fail '三条候选地址一条都不通，舱内连不上宿主的舱面'
  raw '车到山前必有路，但这里没有：这说明这台机器上「容器 → 宿主」这条链路整个不通，'
  raw '不是 abx 的问题（宿主防火墙、docker 网络模式、VPN 都可能）。'
  printf '\n'
  exit 1
fi
CELL_BASE="http://$CELL_HOST:$CELL_PORT"
ok "探测出的舱面地址：$CELL_BASE（host.docker.internal 解析为 ${HOST_DOCKER_IP:-host-gateway}）"

# ── 3. 硬断言：连通性与令牌 ───────────────────────────────────────────────
step '3. 硬断言：舱内能不能连上，以及舱面认不认令牌'

cell_check 200 "可达 + 正确令牌（头）"     "$CELL_BASE/healthz" "x-abx-cell: $CELL_TOKEN"
cell_check 200 "正确令牌（路径，agent 实际走法）" "$CELL_BASE/c/$CELL_TOKEN/healthz"
cell_check 401 "错误令牌"                  "$CELL_BASE/healthz" "x-abx-cell: abx_cell_wrong-token"
cell_check 401 "不带令牌"                  "$CELL_BASE/healthz"
cell_check 401 "只伪造 cell id 头（不拿它当凭据）" "$CELL_BASE/healthz" "x-abx-cell-id: claude-cell-forged"

# ── 4. 完整链路：舱内 → 舱面 → 注入真密钥 → 宿主上游 ──────────────────────
step '4. 完整链路：舱内发的占位符，上游收到的是真密钥'

ABX_PROBE_METHOD=POST \
ABX_PROBE_BODY='{"model":"fake","messages":[{"role":"user","content":"hi"}]}' \
  cell_fetch "$CELL_BASE/c/$CELL_TOKEN/u/osw/v1/messages" \
  "content-type: application/json" \
  "authorization: Bearer abx-placeholder" \
  "x-abx-cell-id: claude-cell-1" || true

if [ -s "$WORK/upstream-seen.json" ]; then
  raw "上游实际收到的（$WORK/upstream-seen.json）："
  cat "$WORK/upstream-seen.json" | while read -r line; do raw "$line"; done
  if grep -q "Bearer $FAKE_SECRET" "$WORK/upstream-seen.json"; then
    ok '上游收到的是宿主的真密钥（凭据注入跨过了容器边界）'
  else
    fail '上游没收到真密钥'
  fi
  if grep -q 'abx-placeholder' "$WORK/upstream-seen.json"; then
    fail '舱内发的占位符被原样转发出去了'
  else
    ok '舱内发的占位符没有出现在上游那一侧'
  fi
else
  fail '上游一个请求都没收到'
fi

# ── 5. 规格探针：设计里要求了、实现里还没有的两条 ──────────────────────────
step '5. 规格探针：§20.3 与 §19.1 里尚未落地的两条（不影响退出码，但必须看见）'

run "docker run --rm $IMAGE node -e '<同一个令牌，声称自己是另一个舱>'"
FORGED="$(cell_fetch_code "$CELL_BASE/healthz" "x-abx-cell: $CELL_TOKEN" 'x-abx-cell-id: claude-cell-forged')"
raw "正确令牌 + 伪造的 x-abx-cell-id -> HTTP ${FORGED:-无响应}"
if [ "$FORGED" = "401" ]; then
  ok '舱面拒绝了与令牌不符的 cell id（§20.3 已落地）'
else
  gap "§20.3 要求「令牌绑定的舱 id 与请求头不一致就拒绝」，当前实现返回 ${FORGED:-无响应}：cellId 仍然由舱自报，审计里的归属可伪造"
fi

run "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$CELL_PORT/healthz -H 'x-abx-cell: <令牌>'"
FROM_HOST="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CELL_PORT/healthz" -H "x-abx-cell: $CELL_TOKEN" 2>/dev/null)"
raw "从宿主回环打舱面（来源 127.0.0.1，不在 docker 网段内）-> HTTP ${FROM_HOST:-无响应}"
if [ "$FROM_HOST" = "401" ] || [ "$FROM_HOST" = "403" ]; then
  ok '来源不在 docker 网段的请求被拒（§19.1 的补偿措施已落地）'
else
  gap "§19.1 要求「非 docker VM 网段的请求一律拒绝，即便令牌正确」，当前实现返回 ${FROM_HOST:-无响应}：绑 0.0.0.0 换来的暴露面没有任何补偿"
fi

# 第二条不是「行为不对」，是「这个行为压根不存在」——所以直接看源码里有没有这个东西。
# 有网段校验就一定会出现来源地址的判断，而来源地址只能来自 remoteAddress。
run "grep -rn '192\.168\.65\|remoteAddress' packages/core/source packages/contracts/source"
SUBNET_HITS="$(grep -rn '192\.168\.65\|remoteAddress' packages/core/source packages/contracts/source 2>/dev/null | wc -l | tr -d ' ')"
raw "命中 $SUBNET_HITS 行"
if [ "$SUBNET_HITS" = "0" ]; then
  raw '→ 一行都没有：core 里既没有网段常量，也没有读过来源地址，所以第一条探针的 200 不是漏判，是这条检查不存在'
fi

# ── 6. 附：§19.2 的共享路径坑 ─────────────────────────────────────────────
step '6. 附：§19.2 的挂载共享路径坑（复现原始报错，供运维文档引用）'

mkdir -p "$WORK/mount-source"
run "docker run --rm -v $WORK/mount-source:/workspace $IMAGE true"
MOUNT_ERR="$(docker run --rm -v "$WORK/mount-source:/workspace" "$IMAGE" true 2>&1)"
if [ -z "$MOUNT_ERR" ]; then
  raw "这次挂上了（本机把 ${TMPDIR:-/tmp} 也算作共享路径），这台机器上复现不了这个坑"
else
  printf '%s\n' "$MOUNT_ERR" | head -4 | while read -r line; do raw "$line"; done
  raw '→ 用户看到的就是上面这句。它没说清「哪个目录该搬到哪」，所以要自己翻译成人话。'
fi

# ── 7. 结论 ───────────────────────────────────────────────────────────────
step '7. 结论（可直接粘贴）'

printf '  abx 真实 docker 验证 · %s\n' "$(date '+%Y-%m-%d %H:%M')"
printf '  环境：docker server %s · 镜像 %s · 宿主 %s\n' "$DOCKER_SERVER" "$IMAGE" "$(uname -s)"
printf '  舱面：%s（broker.cellHost=0.0.0.0，端口由系统分配）\n' "$CELL_BASE"
printf '  舱内可达性（401 = 到了舱面、只是没带令牌）：\n'
printf '    host.docker.internal %s\n    192.168.65.2        %s\n    172.17.0.1          %s\n' \
  "$REACH_HOST_DOCKER" "$REACH_VM_GATEWAY" "$REACH_BRIDGE_GW"
printf '  宿主绑定：0.0.0.0 OK · 172.17.0.1 %s\n' "$BIND_BRIDGE"
printf '  令牌：正确 200 · 错误 401 · 缺失 401 · 只伪造 cell id 头 401\n'
printf '  凭据注入：舱内发占位符 → 上游收到宿主的真密钥\n'
printf '  规格未满足：%s 条（%s）\n' "$GAPS" "$([ "$GAPS" = "0" ] && printf '无' || printf '见第 5 步，两条都属 core 尚未落地的作业')"

printf '\n'
if [ "$FAILED" = "1" ]; then
  printf '\033[31m有硬断言没通过。\033[0m\n'
  exit 1
fi
printf '\033[32m硬断言全部通过。\033[0m\n'
