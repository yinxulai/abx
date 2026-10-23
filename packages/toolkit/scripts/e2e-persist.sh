#!/usr/bin/env bash
#
# Abx 真实 docker 验证：**实例目录，历史真的跨会话活下来了吗。**
#
# 为什么需要它：`--rm` 让容器退出即销毁，所以「持久化」这件事只可能发生在宿主上。
# 单测能证明挂载清单里有那两个点（目录 rw、目录里的配置 ro），但证明不了
# 「容器里写下的东西，下一次真的还在」—— 那要真的起两次容器。
#
# 这份脚本验两件事，用真 docker、真容器、真宿主目录：
#
#   A. **真编排**：调 `runOpen()` 两次（同一个实例 id，两次 cellId 不同），验实例
#      目录被建出来、生成的配置落在里面、真正的 `docker run` argv 里挂的是哪两个点、
#      宿主侧的 `sessions.jsonl` 一行一次运行。镜像是 node:22-slim，里面没有 `claude`，
#      所以舱内那个命令起不来（退出码非 0）——这一部分验的是**挂载编排与记账**，
#      不是 agent 能不能跑。
#
#   B. **真读写**：直连后端起容器，舱内用 `sh` 在 `~/.claude/` 里写历史。第一次写，
#      容器随 `--rm` 销毁；第二次带**同一个实例 id** 再起，把那份历史读回来。
#      顺带验 `settings.json` 在舱内**读得到、改不动**：目录整体可写，
#      而这一格被一层嵌套的只读挂载盖住。
#
# 「真正的 argv」是怎么拿到的：PATH 最前面放一个**透明**的 `docker` 包装脚本，
# 它把收到的参数记一行 JSONL，然后**原样转发**给真 docker。这样断言的是 docker
# 实际收到的命令行，而不是我们以为它会收到什么。
#
# 脚本不写任何真实凭据（这里根本不需要凭据：不起上游、不转发请求），也不会碰开发者
# 真实的 `~/.abx/instances`——实例根被指到临时目录里。
#
#   bash packages/toolkit/scripts/e2e-persist.sh            # 跑全部
#   bash packages/toolkit/scripts/e2e-persist.sh --keep     # 跑完不清理临时目录
#
# 退出码：0 = 硬断言全过（docker 不可用也走这条，并说明原因）；1 = 某条硬断言没过。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

IMAGE="${ABX_E2E_IMAGE:-node:22-slim}"
INSTANCE_ID='claude'
FAKE_SECRET='FAKE-SECRET-e2e-persist-0000-not-a-real-key'

# 临时目录必须在 **$HOME 之下**：Docker Desktop 只把 home 下的路径共享给虚拟机，
# `/tmp` 里的目录挂不进容器（本机实测的报错是「is not shared from the host」）。
WORK="$(mktemp -d "$HOME/.abx-e2e-persist-XXXXXX")"
FAILED=0

cleanup() {
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

# ── 0. docker 可用吗 ──────────────────────────────────────────────────────
# 和 e2e-docker.sh 一样的规矩：「不可用」不算失败，但也**不许**表现成通过。
step '0. docker 可用吗'

if ! command -v docker >/dev/null 2>&1; then
  printf '  docker 命令不在 PATH 上，\033[33m这次没有验证任何东西\033[0m。\n'
  exit 0
fi
REAL_DOCKER="$(command -v docker)"

DOCKER_SERVER="$(docker info --format '{{.ServerVersion}}' 2>&1)"
if [ "$?" != "0" ]; then
  printf '  docker 客户端在，但连不上守护进程，\033[33m这次没有验证任何东西\033[0m。\n'
  printf '  守护进程的原话：%s\n' "$(printf '%s' "$DOCKER_SERVER" | head -3 | tr '\n' ' ')"
  exit 0
fi
ok "docker 守护进程可用（server $DOCKER_SERVER，client $REAL_DOCKER）"

run "docker image inspect $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf '  本机没有 %s，正在拉取……\n' "$IMAGE"
  if ! docker pull "$IMAGE" >"$WORK/pull.log" 2>&1; then
    printf '  拉取失败，\033[33m这次没有验证任何东西\033[0m。原话：\n'
    tail -3 "$WORK/pull.log" | while read -r line; do raw "$line"; done
    exit 0
  fi
fi
ok "镜像 $IMAGE 就绪"

# ── 1. 准备：解析钩子 / 透明 docker 包装 / 临时配置 / 驱动 ─────────────────
step '1. 准备：临时实例根、临时配置、驱动脚本'

# 核心代码是 TS，入口之间用无扩展名 import（`from './audit'`），node 的 ESM
# 解析器不认。给它挂一个只做「补 .ts / 补 /index.ts」的解析钩子，用的全是 node
# 内置模块，没有新增任何依赖。
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

# 透明的 docker 包装：记一行真实的 argv，然后原样转发。
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
printf '%s\\n' "\$@" > /dev/null
node -e 'require("node:fs").appendFileSync(process.env.ABX_DOCKER_ARGV_LOG, JSON.stringify(process.argv.slice(1)) + "\n")' "\$@"
exec "$REAL_DOCKER" "\$@"
EOF
chmod +x "$WORK/bin/docker"

# 端口不能写 0（配置 schema 要求 1..65535），所以现取两个空闲端口写进配置。
free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}
HOST_PORT="$(free_port)"
CELL_PORT="$(free_port)"

# 真配置，走真 schema（loadConfig 会校验）。刻意**不写 session.cellHome**：
# 要验的正是「默认值 /home/node 一路传到舱内的挂载点上」。
cat > "$WORK/abx.config.json" <<EOF
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
  "egress": { "allow": [{ "pattern": "api.anthropic.com", "upstreamId": "anthropic" }] },
  "upstreams": [
    {
      "id": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authHeader": "authorization",
      "authScheme": "Bearer",
      "secretEnv": "ABX_E2E_FAKE_SECRET"
    }
  ],
  "session": {
    "backend": "docker",
    "image": "$IMAGE",
    "user": "1000:1000",
    "network": "bridge",
    "workdir": "/workspace",
    "limits": { "memory": "1g", "pids": 128, "cpus": 1 },
    "tmpfsSizeMb": 32
  }
}
EOF

mkdir -p "$WORK/task-open" "$WORK/task-cell"
raw "临时目录 $WORK（在 \$HOME 之下：Docker Desktop 只共享 home，/tmp 挂不进去）"
raw "宿主面端口 $HOST_PORT · 舱面端口 $CELL_PORT · 实例根 $WORK/instances"
ok '临时配置就绪（真 schema，cellHome 走默认值，容器里没有 claude 命令）'

# ── 驱动 A：调真的 runOpen ────────────────────────────────────────────────
CORE="$REPO/packages/core/source"
cat > "$WORK/open-driver.mjs" <<'EOF'
// 调**真的** runOpen。挂载清单不由这里断言——它从 docker 包装脚本记下的
// 真实 argv 里读（见 shell 那侧的 check-argv）。
import { writeFileSync } from 'node:fs'

const CORE = process.env.ABX_CORE_SOURCE
const { resolveContext } = await import(`${CORE}/commands/runtime.ts`)
const { runOpen } = await import(`${CORE}/commands/open.ts`)

const { ABX_WORK_DIR, ABX_TASK_DIR, ABX_INSTANCE_ID, ABX_CONFIG_PATH, ABX_RUN } = process.env
const lines = []
const context = resolveContext({ cwd: ABX_TASK_DIR, env: process.env, configPath: ABX_CONFIG_PATH })

const code = await runOpen({
  options: {
    positionals: ['claude', ABX_TASK_DIR],
    configPath: ABX_CONFIG_PATH,
    backend: 'docker',
    json: false,
    tail: false,
    dryRun: false,
    instance: ABX_INSTANCE_ID,
    cellHost: null,
    tokenFile: null,
  },
  context,
  log: (message) => {
    lines.push(message)
    console.log(message)
  },
})

writeFileSync(`${ABX_WORK_DIR}/open-run-${ABX_RUN}.json`, JSON.stringify({ code, lines }, null, 2))
process.exit(0)
EOF

# ── 驱动 B：直连后端起真容器 ──────────────────────────────────────────────
cat > "$WORK/cell-driver.mjs" <<'EOF'
// 除了「跑什么命令」之外，路径与挂载全部由**真的** core 代码算出来：
// planInstance → ensureInstanceStateDir → assertStateDirPolicy → stageAgentConfig
// → MOUNT_POLICY.buildMounts → createDockerBackend（它自己再过一遍 assertMountPolicy）。
import { readFileSync, writeFileSync } from 'node:fs'

// 驱动住在临时目录里（仓库外面），所以 `@abx/*` 这种裸标识符解析不到——
// 一律按**绝对路径**导入源码文件。这些文件自己的相对 import 由解析钩子补扩展名。
const REPO = process.env.ABX_REPO
const { findAgent, loadConfig } = await import(`${REPO}/packages/contracts/source/index.ts`)
const { planInstance, ensureInstanceStateDir } = await import(`${REPO}/packages/core/source/session/instance.ts`)
const { MOUNT_POLICY, assertStateDirPolicy } = await import(`${REPO}/packages/core/source/session/mount-policy.ts`)
const { stageAgentConfig, toSandboxConfigFiles } = await import(`${REPO}/packages/core/source/session/agent-config.ts`)
const { createDockerBackend } = await import(`${REPO}/packages/core/source/session/docker-backend.ts`)
const { generateCellId } = await import(`${REPO}/packages/core/source/session/env.ts`)

const { ABX_WORK_DIR, ABX_TASK_DIR, ABX_INSTANCE_ID, ABX_CONFIG_PATH, ABX_INSTANCES_ROOT, ABX_RUN, ABX_CELL_CMD } = process.env

const loaded = loadConfig({ filePath: ABX_CONFIG_PATH, env: process.env, readFile: (p) => readFileSync(p, 'utf8') })
if (!loaded.ok) throw new Error(`配置没通过校验：${loaded.issues.map((issue) => issue.message).join('; ')}`)
const config = loaded.config

const agent = findAgent('claude')
const cellHome = config.session.cellHome
const instance = planInstance({ agent, instanceId: ABX_INSTANCE_ID, cellHome, instancesRoot: ABX_INSTANCES_ROOT })
const stateDir = { hostPath: ensureInstanceStateDir(instance), cellPath: instance.cellPath, agentId: agent.id }
assertStateDirPolicy({ stateDirs: [stateDir], instancesRoot: instance.instancesRoot, cellHome })

const staged = stageAgentConfig({
  agentId: agent.id,
  directory: stateDir.hostPath,
  cellOrigin: 'http://127.0.0.1:1',
  upstreamId: agent.upstreamId,
  cellHome,
})
const agentConfigFiles = toSandboxConfigFiles(staged)
const mounts = MOUNT_POLICY.buildMounts(ABX_TASK_DIR, config.session.workdir, agentConfigFiles, [stateDir])

const cellId = generateCellId(agent.id)
const stdout = []
const stderr = []
const handle = await createDockerBackend().create(
  {
    cellId,
    agentId: agent.id,
    command: ['sh', '-c', ABX_CELL_CMD],
    // 脚本/CI 没有终端：照实传 false。产品侧就是靠这个决定加不加 `--tty` 的；
    // 这里若传 true，docker 会拒绝起容器，而本脚本的 nonce 断言会立刻发现。
    allocateTty: false,
    taskDir: ABX_TASK_DIR,
    workdir: config.session.workdir,
    cellHome,
    agentConfigFiles,
    stateDirs: [stateDir],
    env: {},
    forbiddenEnvNames: [],
    limits: config.session.limits,
    image: config.session.image,
    user: config.session.user,
    network: config.session.network,
    tmpfsSizeMb: config.session.tmpfsSizeMb,
  },
  {
    mode: 'pipe',
    onStdout: (chunk) => {
      stdout.push(chunk.toString('utf8'))
      process.stdout.write(chunk)
    },
    onStderr: (chunk) => {
      stderr.push(chunk.toString('utf8'))
      process.stderr.write(chunk)
    },
  },
)

const exit = await handle.exit
writeFileSync(
  `${ABX_WORK_DIR}/cell-run-${ABX_RUN}.json`,
  JSON.stringify(
    {
      cellId,
      instanceId: instance.instanceId,
      stateDir: stateDir.hostPath,
      cellPath: stateDir.cellPath,
      sessionLogPath: instance.sessionLogPath,
      mounts,
      exitCode: exit.code,
      signal: exit.signal,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    },
    null,
    2,
  ),
)
process.exit(0)
EOF

# 真实 argv 的断言：读 docker 包装脚本记下的 JSONL，逐条判。
cat > "$WORK/check-argv.mjs" <<'EOF'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const [logPath, taskDir, stateDir, ttyMode = 'any'] = process.argv.slice(2)
const home = homedir()
const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line !== '')
const invocations = lines.map((line) => JSON.parse(line))

const report = []
const check = (ok, label, detail = '') => report.push(`${ok ? 'PASS' : 'FAIL'}\t${label}${detail === '' ? '' : `\t${detail}`}`)

const runs = invocations.filter((args) => args[0] === 'run')
check(invocations.length > 0, 'abx 真的调了 docker', `${invocations.length} 次调用`)
if (runs.length === 0) {
  process.stdout.write(`${report.join('\n')}\n`)
  process.exit(0)
}

for (const args of runs) {
  const values = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
  const volumes = values('--volume')

  check(args.includes('--rm'), '仍然是一次性容器（--rm）')
  check(args.includes('--read-only'), '根文件系统仍然只读（--read-only）')
  check(values('--env').includes('HOME=/home/node'), '舱内 HOME 显式注入为 /home/node')
  check(args.includes('--interactive'), '--interactive 始终保留（stdin 可读）')
  if (ttyMode === 'present') check(args.includes('--tty'), '有终端时分配 --tty')
  if (ttyMode === 'absent') {
    // 这一条是产品 bug 的回归线：没有终端却带 --tty 时 docker 会直接拒绝起容器，
    // 而失败形态同样是 exit=1，只有断言 argv 才能和「舱内命令自己失败」分开。
    check(!args.includes('--tty'), '没有终端时不给 --tty（否则 docker 直接拒绝起容器）')
  }

  check(volumes.includes(`${stateDir}:/home/node/.claude:rw`), '实例目录以 rw 挂到 /home/node/.claude')
  check(
    volumes.includes(`${stateDir}/settings.json:/home/node/.claude/settings.json:ro`),
    '生成的配置以 ro 挂在实例目录内部那一格',
  )
  check(
    volumes.indexOf(`${stateDir}:/home/node/.claude:rw`) <
      volumes.indexOf(`${stateDir}/settings.json:/home/node/.claude/settings.json:ro`),
    '目录挂载排在配置挂载前面（深的目标赢，不靠顺序也成立，但顺序可读）',
  )
  check(volumes.includes(`${taskDir}:/workspace:rw`), '任务目录仍然以 rw 挂着')

  const writable = volumes.filter((volume) => volume.endsWith(':rw'))
  check(writable.length === 2, '可写的只有两个：任务目录 + 实例目录', writable.join(' '))

  // 宿主上现成的 agent 目录与宿主 home 本身，一个都不许当挂载源。
  const sources = volumes.map((volume) => volume.split(':')[0])
  const forbidden = [home, `${home}/.claude`, `${home}/.codex`, `${home}/.dsh`, `${home}/.ssh`, '/var/run/docker.sock']
  for (const source of sources) {
    check(!forbidden.includes(source), `挂载源不是宿主上的现成路径：${source}`)
  }
}

process.stdout.write(`${report.join('\n')}\n`)
EOF

ok '驱动与断言脚本就绪（除「跑什么命令」外没有替身）'

jq_get() { node -e "try{process.stdout.write(String(require('$1')$2))}catch{process.stdout.write('')}"; }

report() { # 把 check-argv 的 PASS/FAIL 行转成终端输出
  while IFS=$'\t' read -r verdict label detail; do
    [ -z "$verdict" ] && continue
    if [ "$verdict" = "PASS" ]; then ok "$label"; else fail "$label${detail:+（$detail）}"; fi
  done
}

run_driver() { # <驱动> <run 序号> <实例根> <taskDir> [cell 命令]
  local driver="$1" index="$2" root="$3" task="$4" cmd="${5:-}"
  PATH="$WORK/bin:$PATH" \
  ABX_DOCKER_ARGV_LOG="$WORK/argv-$index.log" \
  ABX_CORE_SOURCE="$CORE" \
  ABX_REPO="$REPO" \
  ABX_WORK_DIR="$WORK" \
  ABX_TASK_DIR="$task" \
  ABX_INSTANCE_ID="$INSTANCE_ID" \
  ABX_INSTANCES_ROOT="$root" \
  ABX_CONFIG_PATH="$WORK/abx.config.json" \
  ABX_RUN="${index#*-}" \
  ABX_CELL_CMD="$cmd" \
  ABX_E2E_FAKE_SECRET="$FAKE_SECRET" \
    node --import "$WORK/register.mjs" "$driver" 2>&1
}

# ── 2. A-1：第一次真编排 ──────────────────────────────────────────────────
step '2. A-1：真 runOpen（实例 claude，第 1 次）'

OPEN_ROOT="$WORK/instances"
raw "实例根 $OPEN_ROOT（不是开发者真实的 ~/.abx/instances）"
[ -d "$OPEN_ROOT" ] && fail '实例根不该在跑之前就存在' || ok '跑之前实例根不存在'

# 调用方有没有终端，决定产品该不该给 `--tty`。这里照实探测，断言跟着走。
if [ -t 0 ]; then
  TTY_MODE=present
  raw '本脚本的 stdin 是终端：断言 argv 里有 --tty'
else
  TTY_MODE=absent
  raw '本脚本的 stdin 不是终端（CI / 脚本的常态）：断言 argv 里没有 --tty'
fi

run "node --import $WORK/register.mjs $WORK/open-driver.mjs    # ABX_INSTANCE_ID=claude"
run_driver "$WORK/open-driver.mjs" open-1 "$OPEN_ROOT" "$WORK/task-open" | tee "$WORK/out-open-1.txt" | sed 's/^/  /'

# 防假绿：上一版 docker 永远带 `--tty`，无终端时容器根本起不来，而失败形态同样是
# exit=1——靠退出码「通过」是假的。这里直接断言**舱内确实执行了命令**：
# 镜像里没有 claude，node 入口会把它当脚本执行并报 MODULE_NOT_FOUND，
# 那条报错来自容器内部；起不来时看到的是 docker 自己的 cannot attach stdin。
if grep -q 'cannot attach stdin' "$WORK/out-open-1.txt"; then
  fail '容器根本没起来：docker 拒绝给无终端的 stdin 分配 TTY'
elif grep -q 'Cannot find module' "$WORK/out-open-1.txt"; then
  ok '容器确实起来了：报错来自舱内的 node（镜像里没有 claude），不是 docker'
else
  fail '看不出容器起没起来（既没有舱内报错，也没有 docker 的 TTY 拒绝）'
fi

OPEN_STATE_DIR="$OPEN_ROOT/$INSTANCE_ID/claude"
run "ls -la $OPEN_STATE_DIR"
if [ -d "$OPEN_STATE_DIR" ]; then
  ls -la "$OPEN_STATE_DIR" | sed 's/^/    /'
  ok '实例状态目录被建出来了'
else
  fail '实例状态目录没建出来'
fi

MODE="$(stat -c '%a' "$OPEN_STATE_DIR" 2>/dev/null)"
run "stat -c '%a' $OPEN_STATE_DIR"
raw "$MODE"
[ "$MODE" = "700" ] && ok '权限 0700（里面是会话历史）' || fail "权限是 $MODE，期望 700"

run "cat $OPEN_ROOT/$INSTANCE_ID/sessions.jsonl"
if [ -s "$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl" ]; then
  cat "$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl" | while read -r line; do raw "$line"; done
  ok '宿主侧写了 sessions.jsonl（一次运行一行）'
else
  fail 'sessions.jsonl 没写出来'
fi

[ -f "$OPEN_STATE_DIR/settings.json" ] && ok '生成的 settings.json 落在实例状态目录里面' || fail 'settings.json 不在实例目录里'

run "cat $WORK/argv-open-1.log    # docker 包装脚本记下的真实 argv，逐条断言"
node -e "const l=require('node:fs').readFileSync('$WORK/argv-open-1.log','utf8').trim().split('\n').map(JSON.parse);for(const a of l){console.log('    '+a[0]+' '+a.slice(1,6).join(' ')+' ...');a.forEach((x,i)=>{if(x==='--volume')console.log('      -v '+a[i+1])})}"
node "$WORK/check-argv.mjs" "$WORK/argv-open-1.log" "$WORK/task-open" "$OPEN_STATE_DIR" "$TTY_MODE" | report

# ── 3. A-2：同一个实例 id 再开一次 ────────────────────────────────────────
step '3. A-2：真 runOpen（同一个实例 id，第 2 次）'

run_driver "$WORK/open-driver.mjs" open-2 "$OPEN_ROOT" "$WORK/task-open" | sed 's/^/  /'

RECORDS="$(wc -l < "$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl" | tr -d ' ')"
raw "sessions.jsonl 现在有 $RECORDS 行"
[ "$RECORDS" = "2" ] && ok '两次运行各记一行' || fail "sessions.jsonl 有 $RECORDS 行，期望 2 行"

CELL_1="$(jq_get "$WORK/open-run-1.json" .code)"
CELL_2="$(jq_get "$WORK/open-run-2.json" .code)"
raw "两次 runOpen 的返回码：$CELL_1 / $CELL_2（镜像是 node:22-slim，里面没有 claude 命令）"

if [ "$RECORDS" = "2" ]; then
  IDS="$(node -e "const l=require('node:fs').readFileSync('$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl','utf8').trim().split('\n').map(JSON.parse);console.log(l.map((r)=>r.cellId+' '+r.instanceId+' '+r.backend+' exit='+r.exitCode).join('\n    '))")"
  raw "$IDS"
  SAME_INSTANCE="$(node -e "const l=require('node:fs').readFileSync('$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl','utf8').trim().split('\n').map(JSON.parse);process.stdout.write(String(l[0].instanceId===l[1].instanceId))")"
  DIFF_CELL="$(node -e "const l=require('node:fs').readFileSync('$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl','utf8').trim().split('\n').map(JSON.parse);process.stdout.write(String(l[0].cellId!==l[1].cellId))")"
  [ "$SAME_INSTANCE" = "true" ] && ok '两行记的是同一个实例' || fail '两行的 instanceId 不一样'
  [ "$DIFF_CELL" = "true" ] && ok '两行的 cellId 不同（它是审计身份，每次运行都是新的）' || fail '两行的 cellId 相同'
fi

CELL_ID_2="$(node -e "const l=require('node:fs').readFileSync('$OPEN_ROOT/$INSTANCE_ID/sessions.jsonl','utf8').trim().split('\n').map(JSON.parse);process.stdout.write(l.at(-1).cellId)")"
run "docker ps -a --filter label=abx.cell-id=$CELL_ID_2"
LEFT="$(docker ps -a --filter "label=abx.cell-id=$CELL_ID_2" --format '{{.Names}}' 2>/dev/null)"
raw "还留着的容器：${LEFT:-（没有）}"
[ -z "$LEFT" ] && ok '--rm 仍然生效：容器退出即销毁' || fail "容器没被销毁：$LEFT"

# ── 4. B-1：真容器里写历史 ────────────────────────────────────────────────
step '4. B-1：真容器，在舱内 ~/.claude 里写历史'

CELL_ROOT="$WORK/instances-cell"

CELL_CMD_1="$(cat <<'SH'
set -u
echo "HOME=$HOME"
echo "--- id"; id
echo "--- ls -a \$HOME/.claude"; ls -a "$HOME/.claude"
echo "--- cat \$HOME/.claude/settings.json"; cat "$HOME/.claude/settings.json"
echo "--- 写历史（应该成功）"
mkdir -p "$HOME/.claude/projects"
printf 'hello-from-run-1\n' > "$HOME/.claude/projects/history.jsonl"
echo "HISTORY=$(cat "$HOME/.claude/projects/history.jsonl")"
echo "--- 改 settings.json（应该失败）"
# 把拒绝原因一起收进 stdout：断言要能区分「EROFS」和「权限位不对」。
if write_error=$({ printf 'tampered\n' >> "$HOME/.claude/settings.json"; } 2>&1); then
  echo "SETTINGS-WRITE=ALLOWED"
else
  echo "SETTINGS-WRITE=DENIED $write_error"
fi
echo "--- 往同一个目录里写别的文件（应该成功，证明目录本身还是可写的）"
printf 'sibling\n' > "$HOME/.claude/sibling.txt" && echo "SIBLING-WRITE=OK"
SH
)"

# 防假绿：舱内命令最后回声一个随机 nonce。容器起不来时 stdout 是空的，
# 下面的断言会立刻红；只有命令**真的在容器里执行过**才会出现它。
NONCE_1="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
CELL_CMD_1="$CELL_CMD_1"$'\n'"echo \"CELL-RAN-NONCE=$NONCE_1\""

run "docker run --rm --user 1000:1000 --read-only ... $IMAGE sh -c '<写历史 + 试着改配置>'"
run_driver "$WORK/cell-driver.mjs" cell-1 "$CELL_ROOT" "$WORK/task-cell" "$CELL_CMD_1" | tee "$WORK/out-cell-1.txt" | sed 's/^/  /'

if [ -s "$WORK/cell-run-1.json" ]; then
  raw "舱内退出码 $(jq_get "$WORK/cell-run-1.json" .exitCode)"
  node -e "const l=require('node:fs').readFileSync('$WORK/argv-cell-1.log','utf8').trim().split('\n').map(JSON.parse);for(const a of l){a.forEach((x,i)=>{if(x==='--volume')console.log('    -v '+a[i+1])})}"
  node "$WORK/check-argv.mjs" "$WORK/argv-cell-1.log" "$WORK/task-cell" "$(jq_get "$WORK/cell-run-1.json" .stateDir)" absent | report
  if jq_get "$WORK/cell-run-1.json" .stdout | grep -q "CELL-RAN-NONCE=$NONCE_1"; then
    ok "容器确实执行了舱内命令（nonce $NONCE_1 回声到了 stdout）"
  else
    fail '没看到舱内命令的 nonce：容器可能根本没跑起来'
  fi
else
  fail 'B-1 没跑出结果'
fi

HISTORY_HOST="$CELL_ROOT/$INSTANCE_ID/claude/projects/history.jsonl"
run "cat $HISTORY_HOST"
raw "$(cat "$HISTORY_HOST" 2>/dev/null || echo '(宿主上读不到)')"
if [ -f "$HISTORY_HOST" ] && [ "$(cat "$HISTORY_HOST")" = "hello-from-run-1" ]; then
  ok '舱内写的历史，落在**宿主**的实例目录里'
else
  fail '舱内写的文件没出现在实例目录里'
fi

OUT_1="$(jq_get "$WORK/cell-run-1.json" .stdout)"
printf '%s' "$OUT_1" | grep -q 'SETTINGS-WRITE=DENIED' && ok '舱内改不动 settings.json' || fail 'settings.json 在舱内居然可写'
printf '%s' "$OUT_1" | grep -q 'Read-only file system' && ok '被拒的原因正是只读文件系统（不是权限位）' || raw '（注意：拒绝原因不是 EROFS，值得看一眼）'
printf '%s' "$OUT_1" | grep -q 'SIBLING-WRITE=OK' && ok '同一个目录里别的文件仍然写得动——可写挂载没被那层 ro 顶掉' || fail '目录整体也变成只读了'

# ── 5. B-2：容器已销毁，同一个实例 id 再起一次 ────────────────────────────
step '5. B-2：容器已随退出销毁，带**同一个实例 id** 再起一次'

CELL_ID_B1="$(jq_get "$WORK/cell-run-1.json" .cellId)"
run "docker ps -a --filter label=abx.cell-id=$CELL_ID_B1"
LEFT_B="$(docker ps -a --filter "label=abx.cell-id=$CELL_ID_B1" --format '{{.Names}}' 2>/dev/null)"
raw "第 1 次的容器还在吗：${LEFT_B:-（不在，已被 --rm 销毁）}"
[ -z "$LEFT_B" ] && ok '第 1 次的容器确实没了（持久化靠的是宿主目录，不是留着容器）' || fail '第 1 次的容器还在'

CELL_CMD_2="$(cat <<'SH'
set -u
echo "HOME=$HOME"
echo "--- 读回上一次写下的历史"
cat "$HOME/.claude/projects/history.jsonl"
echo "--- ls -a \$HOME/.claude"; ls -a "$HOME/.claude"
echo "--- 配置每次起舱都会被重写，仍然是只读的"
cat "$HOME/.claude/settings.json"
# 把拒绝原因一起收进 stdout：断言要能区分「EROFS」和「权限位不对」。
if write_error=$({ printf 'tampered\n' >> "$HOME/.claude/settings.json"; } 2>&1); then
  echo "SETTINGS-WRITE=ALLOWED"
else
  echo "SETTINGS-WRITE=DENIED $write_error"
fi
SH
)"

NONCE_2="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
CELL_CMD_2="$CELL_CMD_2"$'\n'"echo \"CELL-RAN-NONCE=$NONCE_2\""

run_driver "$WORK/cell-driver.mjs" cell-2 "$CELL_ROOT" "$WORK/task-cell" "$CELL_CMD_2" | tee "$WORK/out-cell-2.txt" | sed 's/^/  /'

OUT_2="$(jq_get "$WORK/cell-run-2.json" .stdout)"
printf '%s' "$OUT_2" | grep -q "CELL-RAN-NONCE=$NONCE_2" && ok "第二次的容器确实执行了命令（nonce $NONCE_2）" || fail '第二次没看到舱内命令的 nonce：容器可能根本没跑起来'
printf '%s' "$OUT_2" | grep -q 'hello-from-run-1' && ok '第二次起容器，上一次写的历史**还在**（这就是持久化）' || fail '历史没读回来'
printf '%s' "$OUT_2" | grep -q 'SETTINGS-WRITE=DENIED' && ok '第二次仍然是只读的配置' || fail '第二次配置变成可写了'

CELL_A="$(jq_get "$WORK/cell-run-1.json" .cellId)"
CELL_B="$(jq_get "$WORK/cell-run-2.json" .cellId)"
raw "第 1 次 cellId $CELL_A"
raw "第 2 次 cellId $CELL_B"
[ "$CELL_A" != "$CELL_B" ] && ok '两次是两次运行（cellId 不同），同一个实例（目录相同）' || fail '两次的 cellId 相同了'

STATE_DIR_A="$(jq_get "$WORK/cell-run-1.json" .stateDir)"
STATE_DIR_B="$(jq_get "$WORK/cell-run-2.json" .stateDir)"
[ "$STATE_DIR_A" = "$STATE_DIR_B" ] && ok "两次挂的是同一个宿主目录：$STATE_DIR_A" || fail '两次挂的目录不一样'

run "ls -la $CELL_ROOT/$INSTANCE_ID/claude/projects"
ls -la "$CELL_ROOT/$INSTANCE_ID/claude/projects" 2>/dev/null | sed 's/^/    /'

# ── 6. 结论 ───────────────────────────────────────────────────────────────
step '6. 结论（可直接粘贴）'

printf '  abx 实例持久化 · 真实 docker 验证 · %s\n' "$(date '+%Y-%m-%d %H:%M')"
printf '  环境：docker server %s · 镜像 %s · 宿主 %s\n' "$DOCKER_SERVER" "$IMAGE" "$(uname -s)"
printf '  实例：%s（两次运行实例 id 相同，cellId 不同）\n' "$INSTANCE_ID"
printf '  实例目录：%s → %s（rw）\n' "$STATE_DIR_B" "$(jq_get "$WORK/cell-run-2.json" .cellPath)"
printf '  配置：%s → %s/settings.json（ro，嵌在上一行里面）\n' "$STATE_DIR_B/settings.json" "$(jq_get "$WORK/cell-run-2.json" .cellPath)"
printf '  舱内 HOME：/home/node（session.cellHome 的默认值，配置里没写这一项）\n'
printf '  历史：第 1 次写入 → 容器销毁 → 第 2 次读回，内容一致\n'
printf '  配置可写性：读得到，`>>` 被拒（Read-only file system）\n'
printf '  宿主侧记账：%s/instances/%s/sessions.jsonl（两次运行两行）\n' "$WORK" "$INSTANCE_ID"

printf '\n'
if [ "$FAILED" = "1" ]; then
  printf '\033[31m有硬断言没通过。\033[0m\n'
  exit 1
fi
printf '\033[32m硬断言全部通过。\033[0m\n'
