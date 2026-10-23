#!/usr/bin/env bash
#
# Abx 端到端实测：**真 agent（claude）在真容器里，经真气闸，打到真上游。**
#
# 为什么需要它：在这之前，真 docker 验证（`e2e-docker.sh`）只验到「舱内连得上舱面」——
# 因为 `session.image` 的默认镜像 `node:22-slim` 里根本没有 `claude` 这条命令，
# 起舱只能起个空壳。这份脚本补的是那一段：舱里真的跑起一个 agent，
# 它真的发出一次模型请求，请求真的穿过气闸落到上游，答案真的回到舱里。
#
# 三处东西是真的，都不许换成替身：
#   1. 容器 —— 用 `abx-agent-claude:local` 起，参数由 core 的 `buildDockerArgs` 拼；
#   2. 气闸 —— `packages/core/source/broker` 的真 broker，不是替身服务；
#   3. 上游 —— 宿主上 claude 正在用的那个网关（从 `~/.claude/settings.json` 的
#      `env` 段**运行期**读），不是本地假上游。
#
# 只有两处是替身，且都写明了理由：
#   - claude 的提示词是一句「原样回显这个随机串」。随机串是本次运行生成的：
#     舱里的输出里出现它，只可能是真绕了一圈模型（这是「上游真的收到了请求」的舱内证据）。
#   - 另外单独起了一个**本机替身上游**，用来直接观测「上游那一侧收到了什么凭据」。
#     真网关不会告诉我们它收到了什么；替身会。两者验的不是同一件事。
#
# 凭据纪律（硬要求）：
#   - 网关地址与密钥只在**运行期**从 `~/.claude/settings.json` 读，只以环境变量传递，
#     **不进仓库、不进脚本、不进命令行参数、不进日志**。脚本里只有环境变量名。
#   - 打印任何东西之前都过一次脱敏：驱动里所有输出、以及下面 shell 里 cat 出来的
#     审计副本，都是脱敏之后的那一份（`<redacted>`）。临时配置里写的是
#     `${ABX_TEST_UPSTREAM_BASE_URL}` 这种引用，不是地址本身。
#
# 用法：
#   bash packages/toolkit/scripts/build-agent-image.sh     # 先构建镜像
#   bash packages/toolkit/scripts/e2e-agent-claude.sh        # 再跑这个
#   bash packages/toolkit/scripts/e2e-agent-claude.sh --keep # 跑完不清理临时目录
#
# 退出码：0 = 硬断言全过；1 = 有硬断言没过（原始报错都打在上面）。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# 临时目录**不能**落在 /tmp：容器要把任务目录和生成的配置挂进去，而 Docker Desktop
# 只共享宿主上的一部分路径。这台机器上实测 /tmp 不在其中（挂载直接被拒：
# `mounts denied: The path /tmp/... is not shared from the host`），
# 而那个报错看起来像「abx 的挂载策略拒绝了」，其实跟 abx 一点关系都没有。
# 所以默认落在 $HOME 下（Docker Desktop 默认共享它），可用 ABX_E2E_WORK_BASE 覆盖。
WORK_BASE="${ABX_E2E_WORK_BASE:-${XDG_CACHE_HOME:-$HOME/.cache}/abx-e2e}"
mkdir -p "$WORK_BASE"
WORK="$(mktemp -d "$WORK_BASE/agent-claude-XXXXXX")"
FAILED=0
PASSED=0

cleanup() {
  # gateway.json 里有运行期读进来的那把密钥，**任何时候都删掉**：
  # 连 `--keep`（留给现场复查用）也不例外——留现场是为了看日志与审计，
  # 不是为了把密钥留在磁盘上。
  rm -f "$WORK/gateway.json" 2>/dev/null
  if [ -n "${CELL_CONTAINER:-}" ]; then
    docker rm -f "$CELL_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" = "1" ]; then
    printf '\n临时目录保留在 %s（gateway.json 已删）\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
run()  { printf '  \033[2m$'; printf ' %s' "$@"; printf '\033[0m\n'; }
raw()  { printf '    %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAILED=$((FAILED + 1)); }
note() { printf '  \033[33m·\033[0m %s\n' "$1"; }

IMAGE="${ABX_TEST_AGENT_IMAGE:-abx-agent-claude:local}"
HOST_PORT="${ABX_TEST_HOST_PORT:-28888}"
CELL_PORT="${ABX_TEST_CELL_PORT:-28889}"
NONCE="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PROMPT="Reply with exactly this token and nothing else, no punctuation: $NONCE"

# ── 0. 前置 ───────────────────────────────────────────────────────────────
step '0. 前置：docker、镜像、网关设置'

if ! command -v docker >/dev/null 2>&1; then
  fail 'docker 不在 PATH 上，这份脚本验不了任何东西。'
  exit 1
fi
DOCKER_SERVER="$(docker info --format '{{.ServerVersion}}' 2>&1)"
if [ $? != 0 ]; then
  fail 'docker 守护进程连不上，这份脚本验不了任何东西。'
  raw "原话：$(printf '%s' "$DOCKER_SERVER" | head -3 | tr '\n' ' ')"
  raw '怎么起：systemctl --user start docker-desktop（或打开 Docker Desktop 应用）'
  exit 1
fi
ok "docker 守护进程可用（server $DOCKER_SERVER）"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "本机没有镜像 $IMAGE，先构建它："
  raw 'bash packages/toolkit/scripts/build-agent-image.sh'
  exit 1
fi
ok "镜像 $IMAGE 在本地（$(docker image inspect --format '{{.Id}}' "$IMAGE" | cut -c1-19)…）"

# 临时目录必须是 docker 能挂的路径。先花半秒确认，免得后面第一个挂载失败时，
# 报错长得像 abx 的挂载策略在拒绝。
if ! docker run --rm -v "$WORK":/abx-share-probe "$IMAGE" sh -c 'test -d /abx-share-probe' >/dev/null 2>&1; then
  fail "docker 挂不了 $WORK（Docker Desktop 只共享宿主的某些路径，默认是 \$HOME）"
  raw '把这个路径加进 Docker → Settings → Resources → File sharing，'
  raw '或者用 ABX_E2E_WORK_BASE=<已共享的目录> 再跑一次。'
  exit 1
fi
ok "临时目录在 docker 能挂的路径下：$WORK"

# 网关地址与密钥：运行期从宿主 claude 的设置里读，只写进 $WORK 下一个 0600 的文件。
# 这个文件不进 git（$WORK 在 $TMPDIR），也不打印。
ABX_GATEWAY_FILE="$WORK/gateway.json"
if ! node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
const file = path.join(os.homedir(), ".claude", "settings.json")
const settings = JSON.parse(fs.readFileSync(file, "utf8"))
const env = settings.env ?? {}
const missing = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter((name) => !env[name])
if (missing.length > 0) {
  process.stderr.write(`~/.claude/settings.json 的 env 段里没有 ${missing.join(" / ")}\n`)
  process.exit(1)
}
fs.writeFileSync(process.argv[1], JSON.stringify({
  baseUrl: env.ANTHROPIC_BASE_URL,
  key: env.ANTHROPIC_AUTH_TOKEN,
  model: env.ANTHROPIC_MODEL ?? null,
  host: new URL(env.ANTHROPIC_BASE_URL).hostname,
}), { mode: 0o600 })
' "$ABX_GATEWAY_FILE" 2>"$WORK/gateway-read.err"; then
  fail '读不到网关设置（~/.claude/settings.json 的 env 段）。'
  raw "$(cat "$WORK/gateway-read.err")"
  raw '这份脚本不猜地址也不猜密钥：没有就直接停在这里。'
  exit 1
fi
chmod 600 "$ABX_GATEWAY_FILE"
ok '网关设置已从 ~/.claude/settings.json 读入（地址与密钥不回显，也不进日志）'

# 这两行是**唯一**把地址与密钥交给子进程的地方：只经环境变量，不经 argv。
# （`docker run -e NAME=value` 会把值写进命令行，所以下面没有任何一处这么做。）
export ABX_TEST_UPSTREAM_BASE_URL="$(node -e 'process.stdout.write(require(process.argv[1]).baseUrl)' "$ABX_GATEWAY_FILE")"
export ABX_TEST_UPSTREAM_KEY="$(node -e 'process.stdout.write(require(process.argv[1]).key)' "$ABX_GATEWAY_FILE")"
export ABX_TEST_UPSTREAM_HOST="$(node -e 'process.stdout.write(require(process.argv[1]).host)' "$ABX_GATEWAY_FILE")"
ABX_TEST_UPSTREAM_MODEL="$(node -e 'process.stdout.write(require(process.argv[1]).model ?? "")' "$ABX_GATEWAY_FILE")"
export ABX_TEST_UPSTREAM_MODEL
export ABX_TEST_WORK="$WORK"
export ABX_TEST_NONCE="$NONCE"
export ABX_TEST_PROMPT="$PROMPT"
export ABX_TEST_AGENT_IMAGE="$IMAGE"
# 替身上游用的假密钥：以 FAKE- 开头，写死在脚本里也无所谓（它就是个哨兵串）。
export ABX_E2E_FAKE_KEY='FAKE-UPSTREAM-KEY-e2e-agent-0000-not-real'

# ── 1. 临时配置 ───────────────────────────────────────────────────────────
# 形状与 abx.config.json 一样，只改了几处：上游指向宿主上正在用的那个网关、
# 白名单只留网关域名与本机替身上游、审计落到临时目录、镜像换成带 agent 的那个。
# 地址与密钥都写成 `${...}` 引用——这份文件进临时目录，也不会带上任何值。
step '1. 临时配置（上游 = 宿主上正在用的网关）'

cat > "$WORK/abx.config.agent.json" <<'EOF'
{
  "$comment": "e2e 用的临时配置。地址与密钥是 ${...} 引用，值只在环境里。",
  "broker": {
    "hostPort": __HOST_PORT__,
    "cellHost": "${ABX_CELL_HOST:-0.0.0.0}",
    "cellPort": __CELL_PORT__,
    "cellTokenEnv": "ABX_CELL_TOKEN",
    "allowCellTokenInPath": true,
    "auditPath": "${ABX_TEST_WORK}/abx-audit.jsonl",
    "requestTimeoutMs": 120000
  },
  "egress": { "allow": [
    { "pattern": "${ABX_TEST_UPSTREAM_HOST}", "upstreamId": "anthropic" },
    { "pattern": "127.0.0.1", "upstreamId": "echo" }
  ] },
  "upstreams": [
    { "id": "anthropic", "baseUrl": "${ABX_TEST_UPSTREAM_BASE_URL}", "authHeader": "authorization",
      "authScheme": "Bearer", "secretEnv": "ABX_TEST_UPSTREAM_KEY" },
    { "id": "echo", "baseUrl": "http://127.0.0.1:29977", "authHeader": "authorization",
      "authScheme": "Bearer", "secretEnv": "ABX_E2E_FAKE_KEY" }
  ],
  "session": { "backend": "docker", "image": "${ABX_TEST_AGENT_IMAGE:-abx-agent-claude:local}" }
}
EOF
# 端口与工作目录用占位符替换，而不是让配置层去展开：那两个值不是字符串字面量
# 意义上的「配置引用」，塞进 `${...}` 只会让数字字段多一层解析歧义。
sed -i "s/__HOST_PORT__/$HOST_PORT/; s/__CELL_PORT__/$CELL_PORT/" "$WORK/abx.config.agent.json"

CONFIG="$WORK/abx.config.agent.json"
AUDIT_REDACTED="$WORK/abx-audit.redacted.jsonl"
DRIVER="$WORK/driver.mjs"

raw "配置 $CONFIG"
note '这份配置里只有 ${...} 引用：网关地址与密钥一个字都没落盘，也没进 argv'

# 端口必须先是空的：`ensureBroker` 那类逻辑看到端口有人听就会去「接上」，
# 于是这次断言验的可能是上一轮留下的进程。这种「看着通过、其实验的是别人」更坏。
for port in "$HOST_PORT" "$CELL_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    exec 3>&- 2>/dev/null
    fail "端口 $port 上已经有东西在听（大概是上一轮留下的 broker）。先停掉再跑。"
    raw "查是谁占着：ss -ltnp | grep $port"
    exit 1
  fi
done
ok "端口 $HOST_PORT / $CELL_PORT 都是空的"

# ── 驱动脚本 ──────────────────────────────────────────────────────────────
# 产品没有命令行，所以这里生成一个小驱动，直接 import core 的模块。
# core 是 TS 源码、入口之间用无扩展名 import（`from './audit'`），node 的 ESM 解析器
# 不认（vitest 认，所以单测没暴露）。挂一个十几行的解析钩子补 `.ts` / `/index.ts`，
# 用的全是 node 内置模块，没有新增依赖。
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

cat > "$DRIVER" <<'EOF'
// e2e 的驱动：不依赖任何命令行产品，直接 import core 的模块。
//
// 它做四件事，每件都只用真实实现：
//   1. 用**命令层**的 `resolveContext` 读那份临时配置（环境变量引用、交叉校验、
//      白名单覆盖全都真的过一遍）；
//   2. 用**真 broker** 起宿主面 + 舱面，并给这次会话注册一个专属舱令牌
//      （这正是 `abx open` 走的那条路）。起点用的是 `startBroker` 而不是命令层的
//      `runBroker`：后者是前台阻塞的，而起完还得在同一个进程里注册舱令牌、起容器。
//      命令层的 `runBroker` 内部调的就是同一个 `startBroker`，层没有绕过去；
//   3. 用**真 docker 后端**（`createDockerBackend` → `buildDockerArgs`）起舱，
//      命令是 `claude -p '<提示词>'`；
//   4. 把观测写成 JSON 交给 shell —— 断言留在 shell 里，因为要断言的是
//      「网络那一侧到底收到了什么」，那件事只有从外面看才作数。
//
// 所有打印都过一遍 `redact()`：网关地址、密钥在驱动里是环境变量，
// 任何一个字符都不该出现在终端上。
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.env.ABX_REPO
const WORK = process.env.ABX_TEST_WORK
const CONFIG = process.env.ABX_TEST_CONFIG
const NONCE = process.env.ABX_TEST_NONCE
const PROMPT = process.env.ABX_TEST_PROMPT
const MODEL = process.env.ABX_TEST_UPSTREAM_MODEL
const TIMEOUT_MS = Number(process.env.ABX_TEST_CELL_TIMEOUT_MS ?? 180000)
const CANDIDATES = (process.env.ABX_TEST_CELL_CANDIDATES ?? 'host.docker.internal 172.17.0.1 192.168.65.2')
  .split(/\s+/)
  .filter(Boolean)

/** 打印前先脱敏。要脱的就三样：密钥、网关地址、网关主机名。 */
const REDACTIONS = [process.env.ABX_TEST_UPSTREAM_KEY, process.env.ABX_TEST_UPSTREAM_BASE_URL, process.env.ABX_TEST_UPSTREAM_HOST]
  .filter((value) => typeof value === 'string' && value !== '')
function redact(text) {
  let out = String(text)
  for (const value of REDACTIONS) out = out.split(value).join('<redacted>')
  return out
}
const log = (message) => process.stdout.write(`${redact(message)}\n`)
const write = (name, value) => writeFileSync(path.join(WORK, name), `${redact(JSON.stringify(value, null, 2))}\n`)

/** 洗掉 CRLF 与 ANSI 控制序列。容器是在 PTY 下跑的，输出里两样都有。 */
function strip(text) {
  // eslint-disable-next-line no-control-regex -- 洗的就是控制字符
  return text.replaceAll('\r\n', '\n').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

const core = (name) => pathToFileURL(path.join(REPO, 'packages/core/source', name)).href
const contracts = () => pathToFileURL(path.join(REPO, 'packages/contracts/source/index.ts')).href

const { resolveContext } = await import(core('commands/runtime.ts'))
const { startBroker, collectSecretEnvNames, generateCellToken } = await import(core('broker/index.ts'))
const {
  buildCellEnv,
  cellRootFor,
  containerName,
  createDockerBackend,
  buildDockerArgs,
  generateCellId,
  MOUNT_POLICY,
  stageAgentConfig,
  toSandboxConfigFiles,
} = await import(core('session/index.ts'))
const { findAgent } = await import(contracts())

const TASK_DIR = path.join(WORK, 'task')

/** 逐行读审计 JSONL；读不到就返回空数组（「没有记录」由断言去说话）。 */
function readAudit(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// ── 断言用的小工具 ────────────────────────────────────────────────────────
const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail: detail === undefined ? null : redact(detail) })
  log(`  ${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` —— ${redact(detail)}`}`)
}

// ── 1. 配置（真命令层）────────────────────────────────────────────────────
const context = resolveContext({ cwd: REPO, env: process.env, configPath: CONFIG })
const config = context.config
const agent = findAgent('claude')
if (agent === null) throw new Error('注册表里没有 claude')

const upstream = config.upstreams.find((candidate) => candidate.id === agent.upstreamId)
if (upstream === undefined) throw new Error(`配置里没有 ${agent.upstreamId} 上游`)

log('[config] 配置读进来了（命令层的 resolveContext：环境变量引用、交叉校验、白名单覆盖全过）')
log(`[config] 后端 ${config.session.backend} · 镜像 ${config.session.image} · 用户 ${config.session.user}`)
log(`[config] 舱面绑定 ${config.broker.cellHost}:${config.broker.cellPort} · 宿主面 ${config.broker.host}:${config.broker.hostPort}`)
log(`[config] claude 的上游 ${upstream.id}：baseUrl ${redact(upstream.baseUrl)} · 凭据来源 secretEnv=${upstream.secretEnv}`)
log(`[config] 出口白名单 ${config.egress.map((rule) => redact(rule.pattern)).join(', ')}`)
log(`[config] 资源限额 内存 ${config.session.limits.memory} / pids ${config.session.limits.pids} / cpus ${config.session.limits.cpus}`)

const backend = config.session.backend
if (backend !== 'docker') throw new Error(`这份 e2e 只跑 docker 后端，配置里是 ${backend}`)
if (!config.session.image.startsWith('abx-agent-claude')) {
  throw new Error(`session.image 是 ${config.session.image}，不是本任务构建的那个 agent 镜像`)
}

// ── 2. 真 broker ──────────────────────────────────────────────────────────
const handle = await startBroker({
  config,
  env: process.env,
  cellToken: generateCellToken(),
  cellHost: config.broker.cellHost,
  logger: { info: (m) => log(`[broker] ${m}`), warn: (m) => log(`[broker] ⚠ ${m}`), error: (m) => log(`[broker] ✗ ${m}`) },
})

const cellPort = Number(new URL(handle.cellOrigin).port)
const hostPort = Number(new URL(handle.hostOrigin).port)
log(`[broker] 宿主面 ${handle.hostOrigin} · 舱面绑定 ${config.broker.cellHost}:${cellPort}`)

const cellId = generateCellId('claude')
const cellToken = handle.registerCell(cellId)
log(`[cell] 会话 ${cellId}（已注册专属令牌；与 abx open 同一条路）`)

// `buildDockerArgs` 里写死了 `--interactive --tty`（终端里的 `abx open` 需要它）。
// docker 客户端在这种情况下要求**它自己的 stdin 是一个终端**，否则直接拒绝：
//
//   cannot attach stdin to a TTY-enabled container because stdin is not a terminal
//
// 而 docker 后端在 pipe 模式下把子进程的 stdin 设成 `'ignore'`，于是容器根本起不来。
// 这里只把 stdin 从 `'ignore'` 换成 `'inherit'` —— **安全相关的 flag 一个都没动**，
// 换的只是「谁来当这个终端」。代价是本脚本必须跑在一个 TTY 下（下面先检查），
// 这是 abx 当前的真实约束，不是这份夹具的偏好。
if (!process.stdin.isTTY) {
  throw new Error(
    '驱动需要在一个 TTY 下跑：buildDockerArgs 带 `--interactive --tty`，docker 客户端要求自己的 stdin 是终端。\n' +
      '  用 `script -qec "<命令>" /dev/null` 包一层（e2e-agent-claude.sh 就是这么做的）。',
  )
}
const dockerBackend = createDockerBackend({
  spawnProcess: (command, args, options) => spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] }),
})

/** 用同一套 flag 起一个容器，把输出收回来。probe / 观测 / 两次 agent 运行都走这里。 */
async function runContainer({ label, cellId: id, command, env, configFiles }) {
  const spec = {
    cellId: id,
    agentId: 'claude',
    command,
    taskDir: TASK_DIR,
    workdir: config.session.workdir,
    agentConfigFiles: configFiles ?? [],
    env: env ?? {},
    forbiddenEnvNames: collectSecretEnvNames(config.upstreams),
    limits: config.session.limits,
    image: config.session.image,
    user: config.session.user,
    network: config.session.network,
    tmpfsSizeMb: config.session.tmpfsSizeMb,
  }

  // 先把参数打出来：这一串就是 core 真正交给 docker 的东西（buildDockerArgs 是纯函数，
  // 这里算出来的和 create() 里算出来的逐字相同，下面还会断言一次挂载确实一致）。
  const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, spec.workdir, spec.agentConfigFiles)
  const argv = buildDockerArgs(spec, mounts)
  log(`  [docker] $ docker ${argv.join(' ')}`)

  const stdout = []
  const stderr = []
  const session = await dockerBackend.create(spec, {
    mode: 'pipe',
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  })

  let timedOut = false
  const timer = setTimeout(async () => {
    timedOut = true
    log(`  [docker] ${label} 超过 ${TIMEOUT_MS}ms，强制拆掉容器`)
    spawnSync('docker', ['rm', '-f', containerName(id)], { stdio: 'ignore' })
    await session.stop()
  }, TIMEOUT_MS)

  const exit = await session.exit
  clearTimeout(timer)

  return {
    label,
    cellId: id,
    argv,
    mounts: session.mounts,
    mountsMatch: JSON.stringify(session.mounts) === JSON.stringify(mounts),
    containerName: containerName(id),
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    // `-t` 之下容器输出走 PTY：换行是 CRLF、还夹着 ANSI 控制序列。
    // 断言只看内容，所以这里把它们洗掉，免得「颜色码不一样」被当成内容不一样。
    stdout: strip(Buffer.concat(stdout).toString('utf8')),
    stderr: strip(Buffer.concat(stderr).toString('utf8')),
  }
}

// ── 3. 舱内探测：哪条地址真的能到舱面 ─────────────────────────────────────
// 舱面必须绑 0.0.0.0（实测这台机器上宿主绑不上 172.17.0.1：EADDRNOTAVAIL），
// 而**注入舱内的地址不能是 0.0.0.0** —— 那是「随便哪块网卡」，容器里的 0.0.0.0
// 指的是容器自己。所以绑定地址与通告地址在这里是两件事，通告地址只能探出来。
const PROBE_JS = `
const port = process.argv[1]
for (const host of ${JSON.stringify(CANDIDATES)}) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(\`http://\${host}:\${port}/healthz\`, { signal: controller.signal })
    clearTimeout(timer)
    console.log(\`\${host} -> HTTP \${response.status}\`)
  } catch (error) {
    console.log(\`\${host} -> \${error.cause?.code ?? error.name}\`)
  }
}
`

log('')
log('[probe] 从舱内依次探候选地址（探 /healthz 且不带令牌：HTTP 401 = 到了舱面）')
const probe = await runContainer({
  label: 'probe',
  cellId: `${cellId}-probe`,
  command: ['node', '--input-type=module', '-e', PROBE_JS, String(cellPort)],
})
log(probe.stdout.trimEnd())
write('probe.json', probe)

const reachable = probe.stdout
  .split('\n')
  .map((line) => /^(\S+) -> HTTP 401$/.exec(line.trim()))
  .find((match) => match !== null)
if (reachable === undefined || reachable === null) {
  write('failed.json', { stage: 'probe', probe })
  throw new Error('三条候选地址一条都没到舱面，舱内连不上宿主。原始探测结果见 $WORK/probe.json')
}
const advertiseHost = reachable[1]
const cellOrigin = `http://${advertiseHost}:${cellPort}`
log(`[probe] 探出来的通告地址：${cellOrigin}`)
log(`[probe] 注意：绑定地址是 ${config.broker.cellHost}，通告地址是 ${advertiseHost} —— 两者不同，`)
log('        因为配置里的 broker.cellHost 同时兼着「绑哪儿」和「告诉舱连哪儿」两个职责。')

// ── 4. 生成的配置挂在哪 vs 舱内 agent 去哪儿找 ────────────────────────────
// 这一段是**观测**，不是断言通过与否：它要给「HOME 错配」一个直接证据。
const staged = stageAgentConfig({
  agentId: 'claude',
  cellRoot: path.join(WORK, 'cells', cellId),
  cellOrigin,
  upstreamId: upstream.id,
  cellToken,
  tokenInPath: config.broker.allowCellTokenInPath,
})
const configFiles = toSandboxConfigFiles(staged)
log('')
log('[staged] abx 现生成的配置（宿主路径 → 舱内路径，只读逐个文件挂载）')
for (const file of staged.files) log(`  ${file.hostPath} → ${file.cellPath}`)
log(`[staged] 宿主上生成目录的规则 cellRootFor('${cellId}') = ${cellRootFor(cellId)}（按当前用户的 home 算）`)

const OBSERVE_JS = `
home="$(getent passwd "$(id -u)" | cut -d: -f6)"
mounted="${configFiles[0]?.cellPath ?? '(none)'}"
echo "ABX-OBS uid=$(id -u)"
echo "ABX-OBS home=$home"
echo "ABX-OBS mounted=$mounted"
[ -f "$mounted" ] && echo "ABX-OBS mounted-exists=yes" || echo "ABX-OBS mounted-exists=no"
echo "ABX-OBS agent-reads=$home/.claude/settings.json"
[ -f "$home/.claude/settings.json" ] && echo "ABX-OBS agent-reads-exists=yes" || echo "ABX-OBS agent-reads-exists=no"
touch "$home/.abx-write-probe" 2>/dev/null && echo "ABX-OBS home-writable=yes" || echo "ABX-OBS home-writable=no"
echo "ABX-OBS 明细："
ls -l "$mounted" 2>&1 | sed 's/^/  /'
`
const observation = await runContainer({
  label: 'observe',
  cellId: `${cellId}-observe`,
  command: ['sh', '-c', OBSERVE_JS],
  configFiles,
})
log('')
log('[observe] 舱内看到的样子（同一套 flag：--user / --read-only / --tmpfs / --cap-drop ALL …）')
for (const line of observation.stdout.trimEnd().split('\n')) log(`  ${line}`)
write('observe.json', { ...observation, stagedCellPath: configFiles[0]?.cellPath ?? null })

// ── 5. 真 agent 跑一次 ────────────────────────────────────────────────────
const cellEnv = buildCellEnv({
  agent,
  brokerCellOrigin: cellOrigin,
  cellId,
  cellToken,
  upstreamId: upstream.id,
  tokenInPath: config.broker.allowCellTokenInPath,
})
// 两个**夹具**变量，都不是 abx 注入的，说明白：
//   - 模型名：abx 生成的配置里刻意不写 model（换模型是 OSW 的事），但这次要打的是
//     一个具体的网关，而它只认自己的模型名。所以由这次运行从宿主设置里读出来交给舱内。
//   - 关掉非必要流量：免得 claude 去连 statsig / sentry 那些跟本次验证无关的域名。
if (MODEL !== '') cellEnv.ANTHROPIC_MODEL = MODEL
cellEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

log('')
log('[cell] 舱内会拿到的变量（值里没有真凭据：token 是占位符，baseUrl 指向气闸舱面）')
for (const name of Object.keys(cellEnv).sort()) log(`  ${name} = ${cellEnv[name]}`)

const run1 = await runContainer({
  label: 'claude',
  cellId,
  command: [agent.command, ...agent.args, '-p', PROMPT],
  env: cellEnv,
  configFiles,
})
log('')
log('[cell] claude 的 stdout：')
for (const line of run1.stdout.trimEnd().split('\n')) log(`  ${line}`)
log('[cell] claude 的 stderr：')
for (const line of run1.stderr.trimEnd().split('\n')) log(`  ${line}`)
log(`[cell] 退出码 ${run1.exitCode}${run1.timedOut ? '（超时，容器已被拆掉）' : ''}`)

check('舱内 claude 正常退出', run1.exitCode === 0 && !run1.timedOut, `exit=${run1.exitCode}`)
check('舱内 claude 真的产出了模型输出（随机串回来了）', run1.stdout.includes(NONCE), `nonce=${NONCE}`)

// ── 6. 反向对照：把 abx 注入的两个变量拿掉 ────────────────────────────────
// 挂载原样保留。如果这次也能跑通，说明起作用的是那份**生成的 settings.json**；
// 如果跑不通（预期），说明这条路是靠**环境变量**通的——配合第 4 步的挂载路径，
// 就是「HOME 错配、配置读不到」的直接证据。
const negativeEnv = { ...cellEnv }
delete negativeEnv.ANTHROPIC_BASE_URL
delete negativeEnv.ANTHROPIC_AUTH_TOKEN
delete negativeEnv.ANTHROPIC_CUSTOM_HEADERS

log('')
log('[control] 反向对照：挂载不变，只拿掉 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN')
const run2 = await runContainer({
  label: 'control',
  cellId: `${cellId}-control`,
  command: [agent.command, ...agent.args, '-p', PROMPT],
  env: negativeEnv,
  configFiles,
})
log(`[control] 退出码 ${run2.exitCode}`)
for (const line of `${run2.stdout}${run2.stderr}`.trimEnd().split('\n')) log(`  ${line}`)
check('拿掉那两个变量后跑不通（说明靠的是环境变量，不是挂进去的配置）', !run2.stdout.includes(NONCE))

// ── 7. 凭据替换：替身上游那一侧收到了什么 ─────────────────────────────────
// 真网关不会告诉我们它收到了什么头。所以在同一个 broker 上再配一个本机替身上游，
// 用**舱内那个占位符**去请求它，看它收到的是占位符还是被换过的真密钥。
const substitute = await new Promise((resolve) => {
  const received = []
  const server = createServer((request, response) => {
    received.push({
      url: request.url,
      authorization: request.headers.authorization ?? null,
      'x-abx-cell': request.headers['x-abx-cell'] ?? null,
      'x-abx-cell-id': request.headers['x-abx-cell-id'] ?? null,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  server.listen(29977, '127.0.0.1', async () => {
    const response = await fetch(`http://127.0.0.1:${hostPort}/u/echo/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${agent.placeholderToken}`,
        'x-abx-cell': cellToken,
        'x-abx-cell-id': cellId,
      },
      body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text()
    server.close()
    resolve({ status: response.status, received, placeholder: agent.placeholderToken })
  })
})
write('substitution.json', substitute)

// ── 8. 审计（脱敏副本）────────────────────────────────────────────────────
const auditLines = readAudit(`${WORK}/abx-audit.jsonl`)
const cellRecords = auditLines.filter((record) => record.cellId === cellId)
write('audit-summary.json', {
  total: auditLines.length,
  forThisCell: cellRecords.length,
  records: cellRecords,
  upstreamHost: upstream.baseUrl,
})
writeFileSync(
  `${WORK}/abx-audit.redacted.jsonl`,
  `${auditLines.map((record) => redact(JSON.stringify(record))).join('\n')}\n`,
  { mode: 0o600 },
)

// ── 9. 收尾 ───────────────────────────────────────────────────────────────
handle.unregisterCell(cellId)
await handle.close()

write('cell-run.json', run1)
write('control.json', run2)
write('report.json', {
  cellId,
  nonce: NONCE,
  advertiseHost,
  cellOrigin,
  image: config.session.image,
  staged: staged.files.map((file) => ({ hostPath: file.hostPath, cellPath: file.cellPath })),
  hostHome: cellRootFor(cellId),
  auditRecordsForCell: cellRecords.length,
  checks: results,
})

log('')
log(`[driver] 全部完成：${results.filter((entry) => entry.ok).length}/${results.length} 条驱动内断言通过`)
if (results.some((entry) => !entry.ok)) process.exitCode = 1
EOF

# ── 跑驱动 ────────────────────────────────────────────────────────────────
step '2. 跑起来（真 broker + 真容器 + 真 claude）'

mkdir -p "$WORK/task"
export ABX_REPO="$REPO"
export ABX_TEST_CONFIG="$CONFIG"

# 为什么套一层 `script`：`buildDockerArgs` 带 `--interactive --tty`，而 docker 客户端
# 在这种情况下要求**自己的 stdin 是终端**，否则容器根本起不来（原话见 driver 里的注释）。
# `script -qec` 只是给这条命令分配一个 PTY，argv 里安全相关的 flag 一个都没动。
run script -qec "node --import $WORK/register.mjs $DRIVER" /dev/null
script -qec "node --import $WORK/register.mjs $DRIVER" /dev/null >"$WORK/driver.log" 2>&1
DRIVER_CODE=$?
# 驱动里所有打印都过了红（网关地址与密钥都不在里面），所以这里可以直接 cat。
tr -d '\r' <"$WORK/driver.log" | while IFS= read -r line; do raw "$line"; done

if [ "$DRIVER_CODE" != "0" ]; then
  fail "驱动退出码 $DRIVER_CODE"
else
  ok '驱动正常退出'
fi

# ── 断言 ──────────────────────────────────────────────────────────────────
# 断言留在 shell 里：要断言的是「网络那一侧到底收到了什么」，那件事只有从外面看才作数。
jget() { # <file> <dotted.path>
  node -e '
const fs = require("node:fs")
const [file, expr] = process.argv.slice(1)
const value = expr.split(".").reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), JSON.parse(fs.readFileSync(file, "utf8")))
process.stdout.write(value === undefined || value === null ? "" : String(value))
' "$WORK/$1" "$2"
}

step '3. 舱内 claude 真的产出了输出'

CELL_EXIT="$(jget cell-run.json exitCode)"
CELL_OUT="$WORK/cell-run.stdout.txt"
jget cell-run.json stdout > "$CELL_OUT"
raw "claude 退出码：${CELL_EXIT:-（空）}"
raw "claude stdout：$(cat "$CELL_OUT" | tr '\n' ' ')"
[ "$CELL_EXIT" = "0" ] && ok 'claude 退出码 0' || fail "claude 退出码是 ${CELL_EXIT:-（空）}，不是 0（不是「没报错」，是真失败了）"

if [ -s "$CELL_OUT" ] && grep -q "$NONCE" "$CELL_OUT"; then
  ok "输出里有本次运行生成的随机串 $NONCE（只可能是模型真的回了话）"
else
  fail "输出里没有随机串 $NONCE —— claude 没产出一句模型回答"
fi

step '4. 上游（那个网关）真的收到了这次请求'

AUDIT_FACTS="$(node -e '
const summary = require(process.argv[1])
const hit = summary.records.filter(
  (record) => record.decision === "allowed" && record.status === 200 && record.credentialInjected === true && record.upstreamId === "anthropic",
)
process.stdout.write(JSON.stringify({
  auditLines: summary.total,
  forThisCell: summary.forThisCell,
  allowedWithCredentials200: hit.length,
  decisions: [...new Set(summary.records.map((record) => record.decision))],
}) + "\n")
process.exit(hit.length > 0 ? 0 : 1)
' "$WORK/audit-summary.json")"
AUDIT_CODE=$?
raw "本会话的审计事实：$(printf '%s' "$AUDIT_FACTS" | tr -d '\n')"

if [ "$AUDIT_CODE" = "0" ]; then
  ok '审计里有一条「放行 + 注入了真凭据 + 上游回 200」，说明这次请求真的落到了上游'
else
  fail '审计里没有「放行 + 注入凭据 + 上游 200」的记录，请求没落到上游'
  raw '（审计的脱敏副本，地址已换成 <redacted>）：'
  cat "$AUDIT_REDACTED" | while IFS= read -r line; do raw "$line"; done
fi

step '5. 舱内那个占位符没有出现在上游那一侧'

SUB_AUTH="$(node -e '
const fs = require("node:fs")
const file = process.argv[1]
const data = JSON.parse(fs.readFileSync(file, "utf8"))
const first = data.received[0] ?? {}
process.stdout.write(`${data.status}|${first.authorization ?? "(上游一个请求都没收到)"}|${data.placeholder}`)
' "$WORK/substitution.json")"
SUB_STATUS="${SUB_AUTH%%|*}"
SUB_REST="${SUB_AUTH#*|}"
SUB_AUTHZ="${SUB_REST%%|*}"
PLACEHOLDER="${SUB_REST##*|}"
raw "替身上游收到的 Authorization：$SUB_AUTHZ（HTTP $SUB_STATUS）"

case "$SUB_AUTHZ" in
  *"$PLACEHOLDER"*) fail "上游收到了占位符本身：$SUB_AUTHZ" ;;
  "Bearer FAKE-"*)   ok '上游收到的是气闸换上去的那把密钥（脚本里的 FAKE- 哨兵串），不是舱内的占位符' ;;
  *)                 fail "上游收到的 Authorization 不在预期内：$SUB_AUTHZ" ;;
esac

# 真网关那一侧同理：如果发过去的是占位符，网关会 401，claude 就不可能拿到模型回答。
# 所以上面那两条断言（模型输出 + 审计 200）本身也是「占位符没被发出去」的旁证。
note '真网关那边没法直接看它收到了什么；「占位符没带过去」靠的是上面两件事：替身实测 + 真网关 200'

step '6. 观测：舱内 agent 到底读不读得到那份生成的配置（HOME 错配）'

OBS="$WORK/observe.stdout.txt"
jget observe.json stdout > "$OBS"
grep '^ABX-OBS' "$OBS" | grep -v '明细' | while IFS= read -r line; do raw "$line"; done
printf '  %s\n' '（明细：）'
grep -v '^ABX-OBS' "$OBS" | while IFS= read -r line; do raw "$line"; done

CELL_HOME="$(sed -n 's/^ABX-OBS home=//p' "$OBS")"
MOUNTED="$(sed -n 's/^ABX-OBS mounted=//p' "$OBS")"
AGENT_READS="$(sed -n 's/^ABX-OBS agent-reads=//p' "$OBS")"
MOUNTED_EXISTS="$(sed -n 's/^ABX-OBS mounted-exists=//p' "$OBS")"
AGENT_READS_EXISTS="$(sed -n 's/^ABX-OBS agent-reads-exists=//p' "$OBS")"
HOME_WRITABLE="$(sed -n 's/^ABX-OBS home-writable=//p' "$OBS")"

[ "$MOUNTED_EXISTS" = "yes" ] && ok "abx 生成的配置确实挂进了舱：$MOUNTED" || fail "挂载点上没有配置：$MOUNTED"
[ "$AGENT_READS_EXISTS" = "no" ] && ok "但 agent 会去找的位置是空的：$AGENT_READS" || fail "agent 会去找的位置居然有配置：$AGENT_READS"
if [ "$MOUNTED" != "$AGENT_READS" ]; then
  ok "两个路径不一样：挂载点 $MOUNTED ≠ 舱内 HOME $CELL_HOME 下的 $AGENT_READS"
else
  fail '两个路径居然一样，这条观测的前提不成立'
fi
[ "$HOME_WRITABLE" = "no" ] && note "顺带观测：舱内 HOME=$CELL_HOME 在 --read-only 下不可写（claude -p 仍然跑通了）"

step '7. 反向对照：拿掉 abx 注入的那两个变量，同样的挂载会不会自己生效'

CTRL_OUT="$WORK/control.stdout.txt"
jget control.json stdout > "$CTRL_OUT"
CTRL_EXIT="$(jget control.json exitCode)"
raw "退出码 ${CTRL_EXIT:-（空）} · stdout：$(cat "$CTRL_OUT" | tr '\n' ' ')"
if grep -q "$NONCE" "$CTRL_OUT"; then
  fail '拿掉那两个变量后居然还能跑通 —— 那么起作用的是挂进去的配置，不是环境变量'
else
  ok '拿掉 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 之后跑不通，说明这条路是靠环境变量通的'
fi

# ── 结论 ──────────────────────────────────────────────────────────────────
step '结论'

printf '  abx e2e（真 claude · 真容器 · 真气闸 · 真上游）· %s\n' "$(date '+%Y-%m-%d %H:%M')"
printf '  镜像        %s\n' "$IMAGE"
printf '  镜像 digest %s\n' "$(docker image inspect --format '{{.Id}}' "$IMAGE")"
printf '  舱内 claude %s\n' "$(docker run --rm "$IMAGE" claude --version 2>&1)"
printf '  上游        %s（地址不回显；凭据来源 secretEnv=%s）\n' '宿主正在用的网关' 'ABX_TEST_UPSTREAM_KEY'
printf '  断言        %s 条通过，%s 条未通过\n' "$PASSED" "$FAILED"

printf '\n'
if [ "$FAILED" != "0" ]; then
  printf '\033[31m有断言没通过。\033[0m\n'
  [ "$KEEP" = "0" ] && printf '想留下现场复查就加 --keep 再跑一次。\n'
  exit 1
fi
printf '\033[32m全部通过：舱里的真 agent 经真气闸打到了真上游。\033[0m\n'
exit 0
