#!/usr/bin/env bash
#
# Abx 端到端实测（local 后端 + 本机假上游）。
#
# 为什么需要它：单元测试能证明「函数算得对」，证明不了「这一串东西接起来能跑」。
# 这份脚本就是那串东西——真实的配置解析、真实的 broker 进程、真实的会话编排、
# 真实的环境变量注入、真实的审计落盘，只有两处是假的：
#
#   1. 上游是一个本机 HTTP 服务，它把收到的请求原样回显。**必须**是假的：
#      整个验证的核心就是「上游到底收到了什么」，而真的上游不会告诉你。
#   2. agent 二进制是一个替身脚本。真的 Claude Code 是交互式的，脚本驱动不了。
#      替身只按 Claude Code 的约定读环境变量、发一次请求。
#
# 它和 `e2e-docker.sh` 的分工——两者不重复，谁也不能替代谁：
#
#   e2e-docker.sh  容器是真的、网络是真的、地址解析是真的，但只跑「舱内能不能
#                  连上舱面」这一件事，不起会话、不读审计。
#   本脚本         容器是假的（local 后端压根不起容器），但跑的是本机这条链路的
#                  **全过程**：doctor → broker → 凭据注入 → 出口白名单 →
#                  直通模式 → 审计落盘 → 泄漏检查 → 拆掉 broker 后的旁路检查
#                  → open 起一次真会话 → 读回这次会话的审计。
#
# 所以它不需要 docker：local 后端本来就不起容器，docker 没起来也照样跑。
#
# 驱动方式：产品没有命令行（`apps/cli` 已经在 c4a49d7 里删掉了），所以这里生成一个
# 小驱动，直接 import `packages/core/source/commands/` 的命令层。断言全都留在 shell 里——
# 要断言的是「网络那一侧到底收到了什么」，那件事只有从脚本这一层看才作数。
#
# 脚本不写任何真实凭据：下面的密钥值全都是 `FAKE-...` 开头的假值，
# 它们的作用只是「一个能一眼认出来的字符串」，出现在任何地方都不构成泄漏。
# 审计文件写在临时目录里，仓库根不会留下 `abx-audit.jsonl` 这种残留。
#
#   bash packages/toolkit/scripts/e2e-local.sh            # 跑全部
#   bash packages/toolkit/scripts/e2e-local.sh --keep     # 跑完不清理临时目录
#
set -uo pipefail

# ROOT 必须是**仓库根**：下面所有相对路径（packages/core/...）都是从这里算的。
# 本脚本住在 packages/toolkit/scripts/，所以是往上三层，不是一层。
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/abx-e2e-XXXXXX")"
BROKER_PID=""
UPSTREAM_PID=""
FAILED=0

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
run()  { printf '  \033[2m$'; printf ' %s' "$@"; printf '\033[0m\n'; }
raw()  { printf '    %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }

# ── 端口必须先是空的 ──────────────────────────────────────────────────────
# 上一轮跑剩的 broker 还占着 28788 的话，`open` 会**接上它**而不是自己起一个
# （`ensureBroker` 看到端口有人听就不动它），于是这一次的断言验的可能不是这一次的进程。
# 这种「看着通过、其实验的是别人」的结果比失败更坏，所以先挡一道。
for port in 28788 28789; do
  if curl -sS -o /dev/null --max-time 1 "http://127.0.0.1:$port/healthz" 2>/dev/null; then
    printf '端口 %s 上已经有东西在响应（大概是上一轮留下的 broker）。先停掉它再跑本脚本。\n' "$port"
    printf '查是谁占着：ss -ltnp | grep %s\n' "$port"
    exit 1
  fi
done

# ── 驱动脚本：不依赖 apps/cli ─────────────────────────────────────────────
# 和 e2e-docker.sh 同一套做法，理由也同一条：core 是 TS 源码，入口之间用无扩展名
# import（`from './audit'`），node 的 ESM 解析器不认（vitest 认，所以单测没暴露）。
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

# 极小的 argv 适配器：把 shell 传进来的参数翻译成 core 的 CommandOptions + CommandContext。
# 它**不是**一个命令行产品，只是一份 E2E 夹具，所以它只认本脚本用到的那几个参数。
cat > "$WORK/driver.mjs" <<'EOF'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const coreDir = process.env.ABX_CORE_DIR
if (coreDir === undefined || coreDir === '') {
  throw new Error('驱动脚本需要 ABX_CORE_DIR 指向 core 的 commands 目录')
}

const entry = (name) => pathToFileURL(path.join(coreDir, `${name}.ts`)).href
// `ABX_CORE_DIR` 指向的是 `source/commands`，而宿主平台那一层在它**外面**一层
// （`source/host-platform.ts`）——它是命令层与 session 层共用的东西。
const coreEntry = (name) => pathToFileURL(path.join(coreDir, '..', `${name}.ts`)).href
const { resolveContext, CommandError } = await import(entry('runtime'))
const { requireHostPlatform } = await import(coreEntry('host-platform'))
const { runDoctor } = await import(entry('doctor'))
const { runBroker } = await import(entry('broker'))
const { runOpen } = await import(entry('open'))
const { runAudit } = await import(entry('audit'))

const COMMANDS = { doctor: runDoctor, broker: runBroker, open: runOpen, audit: runAudit }

const argv = process.argv.slice(2)
const command = argv.shift()
const execute = COMMANDS[command]
if (execute === undefined) {
  throw new Error(`不认识的命令：${command ?? '(空)'}。有：${Object.keys(COMMANDS).join(' / ')}`)
}

const options = {
  positionals: [],
  configPath: null,
  backend: null,
  json: false,
  tail: false,
  dryRun: false,
  cellHost: null,
  tokenFile: null,
}

const takesValue = { '--config': 'configPath', '--cell-host': 'cellHost', '--token-file': 'tokenFile' }
const flags = { '--json': 'json', '--tail': 'tail', '--dry-run': 'dryRun' }

while (argv.length > 0) {
  const arg = argv.shift()
  if (Object.hasOwn(takesValue, arg)) {
    const value = argv.shift()
    if (value === undefined) throw new Error(`${arg} 后面要跟一个值`)
    options[takesValue[arg]] = value
  } else if (Object.hasOwn(flags, arg)) {
    options[flags[arg]] = true
  } else if (arg.startsWith('--')) {
    throw new Error(`不认识的参数：${arg}`)
  } else {
    options.positionals.push(arg)
  }
}

const log = (message) => process.stdout.write(`${message}\n`)

try {
  // 宿主平台由**宿主层**读一次再传下去（见 core 的 `host-platform.ts`）：
  // 命令层不自己去读 `process.platform`，所以这个夹具得像产品入口那样读一次。
  // 产品里那一处是 `apps/app/source/main.ts`，这里是它的等价物。
  const context = resolveContext({
    cwd: process.cwd(),
    env: process.env,
    configPath: options.configPath,
    platform: requireHostPlatform(process.platform),
  })
  process.exitCode = await execute({ options, context, log })
} catch (error) {
  if (error instanceof CommandError) {
    process.stderr.write(`✗ ${error.message}\n`)
    if (error.hint !== null) process.stderr.write(`  → ${error.hint}\n`)
  } else {
    process.stderr.write(`✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  }
  process.exitCode = 1
}
EOF

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
console.log(`[standin-claude]   ABX_CELL_ID              = ${process.env.ABX_CELL_ID}`)
console.log(`[standin-claude]   ABX_CELL_TOKEN           = ${process.env.ABX_CELL_TOKEN ?? '(没进舱，对的)'}`)
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
# 形状和 abx.config.json 完全一样，只改了三处：后端换 local，白名单只留本机假上游，
# 审计文件落到临时目录（不往仓库根写）。
# 里面照样只有环境变量名，没有任何密钥。
#
# 两个上游都指向本机假上游是有意的：这样 `open claude` 走的也是这条真链路
# （broker 的凭据注入、白名单判定、审计都真的过一遍），而不是一个特例分支。
# 代价是两边 hostname 相同，而 `X-Abx-Target` 直通时按 hostname 反查上游，
# 命中的是排在前面的 anthropic（见 policy/egress.ts 的 byHost）——第 5 步只看路径，
# 不看它注入了谁的凭据，就是因为这一点。
cat > "$WORK/abx.config.local.json" <<EOF
{
  "broker": {
    "hostPort": 28788,
    "cellPort": 28789,
    "cellTokenEnv": "ABX_CELL_TOKEN",
    "allowCellTokenInPath": true,
    "auditPath": "$WORK/abx-audit.jsonl",
    "requestTimeoutMs": 15000
  },
  "egress": { "allow": [
    { "pattern": "127.0.0.1", "upstreamId": "echo" }
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
AUDIT="$WORK/abx-audit.jsonl"
DRIVER="$WORK/driver.mjs"
CELL='e2e-cell-token-9f3a1c'
FAKE_KEY='FAKE-SECRET-e2e-0000-not-a-real-key'
FAKE_ANTHROPIC='FAKE-ANTHROPIC-KEY-e2e-not-real'

export ANTHROPIC_API_KEY="$FAKE_ANTHROPIC"
export ABX_E2E_FAKE_SECRET="$FAKE_KEY"
export ABX_CELL_TOKEN="$CELL"
export ECHO_PORT=29911
# core 的 TS 源码靠这个钩子才 import 得进来；驱动脚本每次都以它定位命令层。
export ABX_CORE_DIR="$REPO/packages/core/source/commands"

abx() { node --import "$WORK/register.mjs" "$DRIVER" "$@"; }
# 打印**实际发出的**那条命令（钩子与驱动的全路径都在），而不是一个简称。
abx_cmd() { printf 'node --import %s %s' "$WORK/register.mjs" "$DRIVER"; printf ' %s' "$@"; }

mkdir -p "$WORK/task"
node "$WORK/echo-upstream.mjs" > "$WORK/upstream.log" 2>&1 &
UPSTREAM_PID=$!
sleep 0.5
cat "$WORK/upstream.log"

step '0. doctor —— 配置解析 + 环境检查'
run "$(abx_cmd doctor --config "$CFG")"
abx doctor --config "$CFG" > "$WORK/doctor.log" 2>&1
DOCTOR_CODE=$?
cat "$WORK/doctor.log"
printf '  退出码 %s\n' "$DOCTOR_CODE"
# 这份配置里 `session.backend = local`，而 doctor 会把「local 不是沙箱」判成 fail——
# 所以退出码**应该**是 1，而且**只该有这一条**失败。多于一条就说明配置解析或凭据检查
# 真的出问题了，那才是这条断言要抓的东西。
if [ "$DOCTOR_CODE" != "1" ]; then
  fail "doctor 退出码 $DOCTOR_CODE，期望 1（local 后端那条本来就该 fail）"
elif grep -q '，1 项失败。$' "$WORK/doctor.log"; then
  ok '唯一的失败是「local 不是沙箱」这一条，其余检查全过'
else
  fail '失败项不止一条（或者 summary 的措辞变了），看上面的 doctor 输出'
fi

step '1. broker 起来，宿主面 /healthz'
run "$(abx_cmd broker --config "$CFG" --cell-host 127.0.0.1)"
# 这里必须直接起 node，不能走 `abx` 那个 shell 函数：函数会在后台起一个子 shell，
# `$!` 拿到的是子 shell 的 pid，`kill` 杀掉它之后 node 还活着——表现为第 8 步
# 「杀了 broker 还能连上」，看着像有旁路，其实是杀错了进程。
node --import "$WORK/register.mjs" "$DRIVER" broker --config "$CFG" --cell-host 127.0.0.1 > "$WORK/broker.log" 2>&1 &
BROKER_PID=$!
for _ in $(seq 1 50); do curl -sS -o /dev/null "http://127.0.0.1:28788/healthz" 2>/dev/null && break; sleep 0.1; done
cat "$WORK/broker.log"
run curl -sS http://127.0.0.1:28788/healthz
curl -sS http://127.0.0.1:28788/healthz | sed 's/^/    /'; echo

step '2. 凭据注入：舱内发的是占位符，上游收到的是真密钥'
echo '    客户端发出的头：Authorization: Bearer abx-placeholder-echo'
# 不带 X-Abx-Cell-Id：宿主固定令牌绑定的舱叫 `default`，自报一个别的 id 会被舱面
# 按「令牌与舱 id 不符」拒掉（第 3 步单独验这条）。这一步要验的是凭据注入，别的事不掺进来。
run curl -sS -X POST http://127.0.0.1:28789/u/echo/v1/messages -H "X-Abx-Cell: $CELL" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer abx-placeholder-echo' \
  -d '{"model":"fake","messages":[{"role":"user","content":"hi"}]}'
BODY=$(curl -sS -X POST http://127.0.0.1:28789/u/echo/v1/messages \
  -H "X-Abx-Cell: $CELL" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer abx-placeholder-echo' \
  -d '{"model":"fake","messages":[{"role":"user","content":"hi"}]}')
echo "$BODY" | sed 's/^/    /'
echo "$BODY" | grep -q "Bearer $FAKE_KEY" \
  && ok '上游收到的是真密钥' || fail '上游没收到真密钥'
echo "$BODY" | grep -q 'abx-placeholder' \
  && fail '占位符被原样转发出去了' || ok '占位符没有出现在上游那一侧'

step '3. 舱面必须校验令牌；宿主面不校验（它只绑在回环上）'
# check <期望状态码> <说明> <url> [header...]
check() {
  local want="$1" label="$2"; shift 2
  run curl -sS -o /dev/null -w '%{http_code}' "$@"
  local got
  got="$(curl -sS -o /dev/null -w '%{http_code}' "$@")"
  printf '  %-28s -> HTTP %s（期望 %s）\n' "$label" "$got" "$want"
  [ "$got" = "$want" ] && ok "$label" || fail "$label：拿到 $got，期望 $want"
}
check 401 '舱面 不带令牌'        http://127.0.0.1:28789/u/echo/v1/messages
check 401 '舱面 令牌错'          http://127.0.0.1:28789/u/echo/v1/messages -H 'X-Abx-Cell: wrong'
check 200 '舱面 令牌对（头）'    http://127.0.0.1:28789/u/echo/v1/messages -H "X-Abx-Cell: $CELL"
check 200 '舱面 令牌对（路径）'  "http://127.0.0.1:28789/c/$CELL/u/echo/v1/messages"
check 200 '舱面 头+前缀一起带'   "http://127.0.0.1:28789/c/$CELL/u/echo/v1/messages" -H "X-Abx-Cell: $CELL"
check 401 '舱面 令牌对但自报别的舱' http://127.0.0.1:28789/u/echo/v1/messages \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Cell-Id: someone-else'
check 200 '宿主面 不带令牌'      http://127.0.0.1:28788/u/echo/v1/messages

step '4. 出口白名单：没列进去的域名一律 403'
run curl -sS http://127.0.0.1:28789/steal -H "X-Abx-Cell: $CELL" -H 'X-Abx-Target: https://evil.example.net'
DENY=$(curl -sS -w '\n  HTTP %{http_code}' http://127.0.0.1:28789/steal \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Target: https://evil.example.net')
echo "$DENY" | sed 's/^/    /'
echo "$DENY" | grep -q '403' && ok '非白名单域名被拒' || fail '非白名单域名没被拒'

step '5. 直通模式：白名单里的域名放行，只换凭据，路径原样带过去'
run curl -sS "http://127.0.0.1:28789/some/deep/path?a=1" -H "X-Abx-Cell: $CELL" \
  -H 'X-Abx-Target: http://127.0.0.1:29911' -H 'Authorization: Bearer abx-placeholder-echo'
PASS=$(curl -sS "http://127.0.0.1:28789/some/deep/path?a=1" \
  -H "X-Abx-Cell: $CELL" -H 'X-Abx-Target: http://127.0.0.1:29911' \
  -H 'Authorization: Bearer abx-placeholder-echo')
echo "$PASS" | sed 's/^/    /'
echo "$PASS" | grep -q '"/some/deep/path?a=1"' && ok '路径没有被改写' || fail '路径被改写了'

step '6. 审计流水'
cat "$AUDIT" | sed 's/^/    /'

step '7. 审计里有没有泄漏密钥或令牌'
count() { grep -c "$1" "$2" 2>/dev/null || true; }
printf '  真密钥 (audit) : %s\n' "$(count "$FAKE_KEY" "$AUDIT")"
printf '  真密钥 (broker): %s\n' "$(count "$FAKE_KEY" "$WORK/broker.log")"
printf '  舱令牌 (audit) : %s\n' "$(count "$CELL" "$AUDIT")"
[ "$(count "$FAKE_KEY" "$AUDIT")" = "0" ] && ok '审计里没有真密钥' || fail '审计里有真密钥'
[ "$(count "$CELL" "$AUDIT")" = "0" ] && ok '审计里没有舱令牌' || fail '审计里有舱令牌'

step '8. 杀掉 broker，同一个请求必须失败（没有旁路）'
run kill "$BROKER_PID"
kill "$BROKER_PID"; wait "$BROKER_PID" 2>/dev/null; BROKER_PID=""
# 等端口真的关掉再下结论：`kill` 只是投递信号，node 还要跑一轮 handle.close()。
# 少了这段等待，断言就会在「进程还没死透」的那几百毫秒里跑到，看起来像有旁路。
for _ in $(seq 1 50); do
  curl -sS -o /dev/null --max-time 0.2 http://127.0.0.1:28788/healthz 2>/dev/null || break
  sleep 0.1
done
curl -sS -o /dev/null http://127.0.0.1:28789/u/echo/v1/messages 2>&1 && fail 'broker 杀了还能连上' || ok '舱面连不上'
curl -sS -o /dev/null http://127.0.0.1:28788/healthz 2>&1 && fail '宿主面还能连上' || ok '宿主面连不上'
echo '  上游最后一次收到的请求（还是杀之前那条，说明不存在绕过 broker 的旁路）：'
tail -1 "$WORK/upstream.log" | sed 's/^/    /'

step '9. open claude：整条链路（broker 由它自己拉起）'
rm -f "$AUDIT"
export PATH="$WORK:$PATH"
echo "  PATH 里解析到的 claude -> $(command -v claude)"
run "$(abx_cmd open claude "$WORK/task" --config "$CFG")"
abx open claude "$WORK/task" --config "$CFG"
OPEN_CODE=$?
printf '  open 退出码 %s\n' "$OPEN_CODE"
[ "$OPEN_CODE" = "0" ] && ok 'open 正常退出' || fail "open 退出码 $OPEN_CODE"

step '10. open 这次会话的审计'
cat "$AUDIT" | sed 's/^/    /'
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

step '11. audit 命令读回同一条流水'
run "$(abx_cmd audit --config "$CFG")"
abx audit --config "$CFG" | sed 's/^/    /'

# ── 结论 ──────────────────────────────────────────────────────────────────
printf '\n\033[1m=== 结论（可直接粘贴）===\033[0m\n'
printf '  abx 端到端实测（local 后端）· %s\n' "$(date '+%Y-%m-%d %H:%M')"
printf '  环境：宿主 %s · node %s · docker %s（本脚本不需要它）\n' \
  "$(uname -s)" "$(node -v)" "$(command -v docker >/dev/null 2>&1 && echo '在，但没用到' || echo '不在，不影响')"
printf '  命令层：packages/core/source/commands（由本脚本生成的临时驱动 import，未使用任何命令行产品）\n'
printf '  走过的链路：doctor → broker → 凭据注入 → 出口白名单 → 直通 → 审计 → 拆除旁路检查 → open 会话 → 读审计\n'
printf '  两处替身：上游是本机回显服务 · agent 是读环境变量的替身脚本\n'
printf '  断言：%s\n' "$([ "$FAILED" = "1" ] && printf '有未通过项，见上面标红的那几行' || printf '全部通过')"

printf '\n'
if [ "$FAILED" = "1" ]; then
  printf '\033[31m有断言没通过。\033[0m\n'
  exit 1
fi
printf '\033[32m全部断言通过。\033[0m\n'
