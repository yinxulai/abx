#!/usr/bin/env bash
#
# Abx 端到端实测（local 后端 + 本机假上游）。
#
# 为什么需要它：单元测试能证明「函数算得对」，证明不了「这一串东西接起来能跑」。
# 这份脚本就是那串东西——真实的 CLI、真实的配置解析、真实的 broker 进程、
# 真实的会话编排、真实的环境变量注入、真实的审计落盘，只有两处是假的：
#
#   1. 上游是一个本机 HTTP 服务，它把收到的请求原样回显。**必须**是假的：
#      整个验证的核心就是「上游到底收到了什么」，而真的上游不会告诉你。
#   2. agent 二进制是一个替身脚本。真的 Claude Code 是交互式的，脚本驱动不了。
#      替身只按 Claude Code 的约定读环境变量、发一次请求。
#
# 脚本不写任何真实凭据：下面的密钥值全都是 `FAKE-...` 开头的假值，
# 它们的作用只是「一个能一眼认出来的字符串」，出现在任何地方都不构成泄漏。
#
#   ./scripts/e2e-local.sh            # 跑全部
#   ./scripts/e2e-local.sh --keep     # 跑完不清理临时目录
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/abx-e2e-XXXXXX")"
BROKER_PID=""
UPSTREAM_PID=""

cleanup() {
  [ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null
  [ -n "$UPSTREAM_PID" ] && kill "$UPSTREAM_PID" 2>/dev/null
  wait 2>/dev/null
  if [ "$KEEP" = "1" ]; then
    printf '\n临时目录保留在 %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; FAILED=1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
FAILED=0

# ── 假上游 ────────────────────────────────────────────────────────────────
# 它只做一件事：把收到的请求头原样回显。客户端说自己发了什么不算数，
# 要上游说它收到了什么才算数。
cat > "$WORK/echo-upstream.mjs" <<'EOF'
import { createServer } from 'node:http'
const PORT = Number(process.env.ECHO_PORT ?? 29911)
createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const seen = {
      method: req.method,
      url: req.url,
      host: req.headers.host,
      authorization: req.headers.authorization ?? null,
      'x-abx-cell': req.headers['x-abx-cell'] ?? null,
      'x-abx-cell-id': req.headers['x-abx-cell-id'] ?? null,
      'x-abx-target': req.headers['x-abx-target'] ?? null,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    process.stdout.write(`[upstream] ${req.method} ${req.url} authorization=${JSON.stringify(seen.authorization)}\n`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(seen, null, 2))
  })
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`[upstream] 假上游在 127.0.0.1:${PORT} 上听着\n`))
EOF

# ── agent 替身 ────────────────────────────────────────────────────────────
cat > "$WORK/claude" <<'EOF'
#!/usr/bin/env node
// 按 Claude Code 的约定读环境变量，发一次请求，把上游的回显打出来。
import { request } from 'node:http'

const base = process.env.ANTHROPIC_BASE_URL
const token = process.env.ANTHROPIC_AUTH_TOKEN

console.log('[standin-claude] 舱内能看到的变量：')
console.log(`[standin-claude]   ANTHROPIC_BASE_URL       = ${base}`)
console.log(`[standin-claude]   ANTHROPIC_AUTH_TOKEN     = ${token}`)
console.log(`[standin-claude]   ANTHROPIC_CUSTOM_HEADERS = ${process.env.ANTHROPIC_CUSTOM_HEADERS ?? '(无)'}`)
console.log(`[standin-claude]   ABX_CELL_ID          = ${process.env.ABX_CELL_ID}`)
console.log(`[standin-claude]   HOME                     = ${process.env.HOME}`)
console.log(`[standin-claude]   cwd                      = ${process.cwd()}`)
console.log(`[standin-claude]   ANTHROPIC_API_KEY        = ${process.env.ANTHROPIC_API_KEY ?? '(宿主没漏进来)'}`)

// Claude Code 把 ANTHROPIC_CUSTOM_HEADERS 当 "Name: Value" 的多行文本用。
const extra = {}
for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
  const i = line.indexOf(':')
  if (i > 0) extra[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
}

const url = new URL(`${base}/v1/messages`)
const payload = JSON.stringify({ model: 'claude-fake', messages: [{ role: 'user', content: 'hi' }] })
const req = request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      // 舱内唯一拿得到的 token：占位符。真钥匙在 broker 那一侧。
      authorization: `Bearer ${token}`,
      ...extra,
    },
  },
  (res) => {
    let body = ''
    res.on('data', (c) => (body += c))
    res.on('end', () => {
      console.log(`[standin-claude] 上游回显（HTTP ${res.statusCode}）：`)
      console.log(body)
    })
  },
)
req.on('error', (error) => {
  console.error(`[standin-claude] 请求失败：${error.message}`)
  process.exitCode = 1
})
req.end(payload)
EOF
chmod +x "$WORK/claude"

# ── 本机验证用的配置 ──────────────────────────────────────────────────────
# 形状和 abx.config.json 完全一样，只改了两处：后端换 local，
# 两个上游的 baseUrl 都指向本机假上游（把 anthropic 也指过去，
# 是为了让 `abx open claude` 真的走一遍完整链路）。
# 里面照样只有环境变量名，没有任何密钥。
cat > "$WORK/abx.config.local.json" <<EOF
{
  "broker": { "hostPort": 28788, "cellPort": 28789, "allowCellTokenInPath": true, "requestTimeoutMs": 15000 },
  "egress": { "allow": [
    { "pattern": "127.0.0.1", "upstreamId": "echo" },
    { "pattern": "api.anthropic.com", "upstreamId": "anthropic" }
  ] },
  "upstreams": [
    { "id": "anthropic", "baseUrl": "http://127.0.0.1:29911", "authHeader": "authorization",
      "authScheme": "Bearer", "secretEnv": "ANTHROPIC_API_KEY" },
    { "id": "echo", "baseUrl": "http://127.0.0.1:29911", "authHeader": "authorization",
      "authScheme": "Bearer", "secretEnv": "ABX_E2E_FAKE_SECRET" }
  ],
  "session": { "backend": "local" }
}
EOF

CFG="$WORK/abx.config.local.json"
AUDIT="$ROOT/abx-audit.jsonl"
CELL='e2e-cell-token-9f3a1c'
FAKE_KEY='FAKE-SECRET-e2e-0000-not-a-real-key'
FAKE_ANTHROPIC='FAKE-ANTHROPIC-KEY-e2e-not-real'

export ANTHROPIC_API_KEY="$FAKE_ANTHROPIC"
export ABX_E2E_FAKE_SECRET="$FAKE_KEY"
export ABX_CELL_TOKEN="$CELL"
export ECHO_PORT=29911

rm -f "$AUDIT"
mkdir -p "$WORK/task"
node "$WORK/echo-upstream.mjs" > "$WORK/upstream.log" 2>&1 &
UPSTREAM_PID=$!
sleep 0.5
cat "$WORK/upstream.log"

step '0. abx doctor'
node apps/cli/source/index.ts doctor --config "$CFG"

step '1. broker 起来，宿主面 /healthz'
node apps/cli/source/index.ts broker --config "$CFG" --cell-host 127.0.0.1 > "$WORK/broker.log" 2>&1 &
BROKER_PID=$!
for _ in $(seq 1 50); do curl -sS -o /dev/null "http://127.0.0.1:28788/healthz" 2>/dev/null && break; sleep 0.1; done
cat "$WORK/broker.log"
curl -sS http://127.0.0.1:28788/healthz; echo

step '2. 凭据注入：舱内发的是占位符，上游收到的是真密钥'
echo '    客户端发出的头：Authorization: Bearer abx-placeholder-echo'
BODY=$(curl -sS -X POST http://127.0.0.1:28789/u/echo/v1/messages \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Cell-Id: claude-standin-1' \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer abx-placeholder-echo' \
  -d '{"model":"fake","messages":[{"role":"user","content":"hi"}]}')
echo "$BODY"
echo "$BODY" | grep -q "Bearer $FAKE_KEY" \
  && ok '上游收到的是真密钥' || fail '上游没收到真密钥'
echo "$BODY" | grep -q 'abx-placeholder' \
  && fail '占位符被原样转发出去了' || ok '占位符没有出现在上游那一侧'

step '3. 舱面必须校验令牌；宿主面不校验（它只绑在回环上）'
check() { printf '  %-26s -> ' "$1"; curl -sS -o /dev/null -w 'HTTP %{http_code}\n' "${@:3}"; }
check '舱面 不带令牌'          401 http://127.0.0.1:28789/u/echo/v1/messages
check '舱面 令牌错'            401 http://127.0.0.1:28789/u/echo/v1/messages -H 'X-Abx-Cell: wrong'
check '舱面 令牌对（头）'      200 http://127.0.0.1:28789/u/echo/v1/messages -H "X-Abx-Cell: $CELL"
check '舱面 令牌对（路径）'    200 "http://127.0.0.1:28789/c/$CELL/u/echo/v1/messages"
check '舱面 头+前缀一起带'     200 "http://127.0.0.1:28789/c/$CELL/u/echo/v1/messages" -H "X-Abx-Cell: $CELL"
check '宿主面 不带令牌'        200 http://127.0.0.1:28788/u/echo/v1/messages

step '4. 出口白名单：没列进去的域名一律 403'
DENY=$(curl -sS -w '\n  HTTP %{http_code}' http://127.0.0.1:28789/steal \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Target: https://evil.example.net')
echo "$DENY"
echo "$DENY" | grep -q '403' && ok '非白名单域名被拒' || fail '非白名单域名没被拒'

step '5. 直通模式：白名单里的域名放行，只换凭据，路径原样带过去'
PASS=$(curl -sS "http://127.0.0.1:28789/some/deep/path?a=1" \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Target: http://127.0.0.1:29911' \
  -H 'Authorization: Bearer abx-placeholder-echo')
echo "$PASS"
echo "$PASS" | grep -q '"/some/deep/path?a=1"' && ok '路径没有被改写' || fail '路径被改写了'

step '6. 审计流水'
cat "$AUDIT"

step '7. 审计里有没有泄漏密钥或令牌'
count() { grep -c "$1" "$2" 2>/dev/null || true; }
printf '  真密钥 (audit) : %s\n' "$(count "$FAKE_KEY" "$AUDIT")"
printf '  真密钥 (broker): %s\n' "$(count "$FAKE_KEY" "$WORK/broker.log")"
printf '  舱令牌 (audit) : %s\n' "$(count "$CELL" "$AUDIT")"
[ "$(count "$FAKE_KEY" "$AUDIT")" = "0" ] && ok '审计里没有真密钥' || fail '审计里有真密钥'
[ "$(count "$CELL" "$AUDIT")" = "0" ] && ok '审计里没有舱令牌' || fail '审计里有舱令牌'

step '8. 杀掉 broker，同一个请求必须失败（没有旁路）'
kill "$BROKER_PID"; wait "$BROKER_PID" 2>/dev/null; BROKER_PID=""
sleep 0.3
curl -sS -o /dev/null http://127.0.0.1:28789/u/echo/v1/messages 2>&1 && fail 'broker 杀了还能连上' || ok '舱面连不上'
curl -sS -o /dev/null http://127.0.0.1:28788/healthz 2>&1 && fail '宿主面还能连上' || ok '宿主面连不上'
echo '  上游最后一次收到的请求（还是杀之前那条，说明不存在绕过 broker 的旁路）：'
tail -1 "$WORK/upstream.log"

step '9. abx open claude：整条链路（broker 由它自己拉起）'
rm -f "$AUDIT"
export PATH="$WORK:$PATH"
echo "  PATH 里解析到的 claude -> $(command -v claude)"
node apps/cli/source/index.ts open claude "$WORK/task" --config "$CFG"
echo "  open 退出码=$?"

step '10. open 这次会话的审计'
cat "$AUDIT"
# 顺序要紧：先确认文件在、里面有东西，再看内容。
# 少了「文件在不在」这一步，grep 一个不存在的文件也会返回非零，
# 于是断言在「审计压根没写出来」的情况下反而显示通过——这正是它该失败的时候。
if [ ! -s "$AUDIT" ]; then
  fail '这次会话没有留下任何审计记录'
elif grep -q '"cellId":"unknown-cell"' "$AUDIT"; then
  fail '会话 id 没进审计（cellId 是 unknown-cell）'
else
  ok '会话 id 进了审计（能认出是哪个会话）'
fi

step '11. abx audit'
node apps/cli/source/index.ts audit --config "$CFG"

printf '\n'
if [ "$FAILED" = "1" ]; then
  printf '\033[31m有断言没通过。\033[0m\n'; exit 1
fi
printf '\033[32m全部断言通过。\033[0m\n'
