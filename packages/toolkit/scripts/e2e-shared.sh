#!/usr/bin/env bash
#
# Abx 真实 docker 验证：**拖进来的东西真的进舱了吗，不该进的真的没进吗。**
#
# 为什么需要它：单测能证明 `resolveSharedMounts()` 算出来的挂载清单是对的，证明不了
# 「那条 `-v` 真的让舱内看得到宿主上的东西」——挂载是内核与 docker 的事，只有真起
# 容器才算证据。反过来，「被拒的条目容器根本没起」也只有 argv 层面的证据才算数。
#
# 六条硬断言，每条都对应一种会静默出事的方式：
#
#   1. **共享一个真目录 → 舱内读得到、内容一致。** 比对的是 sha256（舱内算一次、
#      宿主算一次），不是「输出里出现了文件名」。
#   2. **舱内写不进去。** 建新文件与被拒的原因（`Read-only file system`，不是权限位），
#      并且宿主上**没有**多出那个文件——挂载是 `ro`，不是「写进去之后再删掉」。
#   3. **目录里有 .env → 拒，而且容器根本没起。** 理由要点名 `.env`；证据是那一次的
#      docker 调用记录里**一条 `run` 都没有**（不是「起来了但没挂上」）。
#   4. **软链按目标判定。** `~/link → /etc` 这种看着正常的链接、指向共享目录之外的
#      凭据文件的链接，都要被拒，理由里说明「这是符号链接，按目标判定」。
#      顺带一条：实例状态目录不许当共享源。
#   5. **重名往后排。** 两个都叫 `notes` 的目录 → `/shared/notes` 与 `/shared/notes-2`，
#      两个都在、内容各是各的（撞车就意味着后一个把前一个盖掉）。
#   6. **整目录绑定，不是快照。** 先在宿主上把挂载清单算出来，**再**往目录里放一个
#      新文件，然后用**那份算好的清单**起容器：新文件必须立刻可见。要是实现是
#      「拖进来那一刻把目录展开成一个个文件」，这里就会少一个文件——而那正是
#      用户永远发现不了的那种失败。
#
# 「真正的 argv」怎么拿到：PATH 最前面放一个**透明**的 `docker` 包装脚本，它把收到的
# 参数记一行 JSONL，然后原样转发给真 docker（同 e2e-persist.sh）。于是断言的是
# docker 实际收到什么，而不是我们以为它收到了什么。
#
# 脚本不写任何真实凭据（这条链根本不需要凭据：不起上游、不转发请求），也不会碰
# 开发者真实的主目录内容——所有素材都在临时目录里现造，实例根指到临时目录里。
#
#   bash packages/toolkit/scripts/e2e-shared.sh            # 跑全部
#   bash packages/toolkit/scripts/e2e-shared.sh --keep     # 跑完不清理临时目录
#
# 退出码：0 = 硬断言全过（docker 不可用也走这条，并说明原因）；1 = 某条硬断言没过。
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

IMAGE="${ABX_E2E_IMAGE:-node:22-slim}"

# 舱内用哪个 uid。产品默认是 `1000:1000`（镜像里 node 用户的 uid）——
# 在 **macOS** 上那是对的：Docker Desktop 的文件共享层会把宿主文件的属主映射成容器
# 里的用户，所以 mac 用户（通常 501）的文件在舱内照样读得到。
# 而 **Linux 上没有这层映射**：宿主 uid 是 1001 时，舱内 uid 1000 连临时目录都进不去，
# 于是「读得到共享目录」这条断言会因为权限而不是挂载失败——那是假红。
# 所以这里照实取宿主自己的 uid：本脚本验的是**挂载**（ro 生效、内容一致），
# 不是 uid 映射；非 root 这一条仍然成立（宿主用户本来就不是 root）。
CELL_USER="$(id -u):$(id -g)"

# 临时目录必须在 **$HOME 之下**：Docker Desktop 只把 home 下的路径共享给虚拟机，
# `/tmp` 里的目录挂不进容器（本机实测的报错是「is not shared from the host」）。
WORK="$(mktemp -d "$HOME/.abx-e2e-shared-XXXXXX")"
FAILED=0

cleanup() {
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
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAILED=1; }

# ── 0. docker 可用吗 ──────────────────────────────────────────────────────
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

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf '  本机没有 %s，正在拉取……\n' "$IMAGE"
  if ! docker pull "$IMAGE" >"$WORK/pull.log" 2>&1; then
    printf '  拉取失败，\033[33m这次没有验证任何东西\033[0m。原话：\n'
    tail -3 "$WORK/pull.log" | while read -r line; do raw "$line"; done
    exit 0
  fi
fi
ok "镜像 $IMAGE 就绪"

# ── 1. 准备：解析钩子 / 透明 docker 包装 / 素材 / 驱动器 ───────────────────
step '1. 准备：临时素材、透明 docker 包装、驱动器'

# 核心代码是 TS，入口之间用无扩展名 import（`from './mount-policy'`），node 的 ESM
# 解析器不认。给它挂一个只做「补 .ts / 补 /index.ts」的解析钩子，用的全是 node
# 内置模块，没有新增任何依赖（同 e2e-persist.sh）。
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
node -e 'require("node:fs").appendFileSync(process.env.ABX_DOCKER_ARGV_LOG, JSON.stringify(process.argv.slice(1)) + "\n")' "\$@"
exec "$REAL_DOCKER" "\$@"
EOF
chmod +x "$WORK/bin/docker"

# 素材。刻意都造在临时目录里：脚本不读也不改开发者自己的任何东西。
#
#   素材 1  notes/             干净目录（整挂用例 + 重名用例的第一个）
#   素材 2  other/notes/       与素材 1 重名，内容不同（重名用例的第二个）
#   素材 3  dirty/             里面有一个 .env（该被拒的目录）
#   素材 4  outside/.env       共享目录**之外**的凭据文件（软链指向它）
#   素材 5  links/home         → $HOME（软链按目标判定）
#   素材 6  links/env          → 素材 4
SHARE="$WORK/share"
mkdir -p "$SHARE/notes/docs" "$SHARE/other/notes" "$SHARE/dirty" "$SHARE/outside" "$SHARE/links"

printf 'MARKER-NOTES-README\n' > "$SHARE/notes/readme.md"
printf 'MARKER-NOTES-PLAN\n' > "$SHARE/notes/docs/plan.md"
printf 'MARKER-OTHER-NOTES\n' > "$SHARE/other/notes/readme.md"
printf 'SECRET=should-never-enter-the-cell\n' > "$SHARE/dirty/.env"
printf 'DATABASE_URL=postgres://user:pw@host/db\n' > "$SHARE/outside/.env"

# `.git` 里塞一堆东西：扫描要整个跳过它（它能把上界无意义地打满），但挂载仍然整挂，
# 所以舱内**看得到** .git —— 「跳过扫描」不等于「不挂」。
mkdir -p "$SHARE/notes/.git/objects"
printf 'object\n' > "$SHARE/notes/.git/objects/00"

ln -s "$HOME" "$SHARE/links/home"
ln -s "$SHARE/outside/.env" "$SHARE/links/env"

# 实例状态目录（abx 自己造的可写地）：它不许当共享源。
INSTANCES_ROOT="$WORK/instances"
mkdir -p "$INSTANCES_ROOT/claude/claude"

mkdir -p "$WORK/task"
raw "临时目录 $WORK（在 \$HOME 之下：Docker Desktop 只共享 home，/tmp 挂不进去）"
raw "素材根 $SHARE · 实例根 $INSTANCES_ROOT（不是开发者真实的 ~/.abx/instances）"
ok '素材就绪（干净目录 / 重名目录 / 带 .env 的目录 / 软链 / 实例状态目录）'

# ── 驱动器：解析 → 起容器 ─────────────────────────────────────────────────
cat > "$WORK/shared-driver.mjs" <<'EOF'
// 共享条目 → 挂载清单 → 真容器。除了「跑什么命令」，路径与挂载全部由**真的** core 算出来：
// `resolveSharedMounts()`（四道闸、整挂、命名去重）→ `createDockerBackend().create()`
// （它自己再过一遍 `assertMountPolicy`）。
//
// 两种用法：
//   - 默认：现场解析，然后（ABX_START=1 时）起容器；
//   - 给了 ABX_MOUNTS_FILE：**不重新解析**，直接用那一份先前算好的挂载清单起容器。
//     用例 6 靠它证明「整目录绑定」——清单是在新文件出现**之前**算的。
import { readFileSync, writeFileSync } from 'node:fs'

// 驱动住在临时目录里（仓库外面），所以 `@abx/*` 这种裸标识符解析不到——
// 一律按**绝对路径**导入源码文件。这些文件自己的相对 import 由解析钩子补扩展名。
const REPO = process.env.ABX_REPO
const { requireHostPlatform } = await import(`${REPO}/packages/core/source/host-platform.ts`)
const { resolveSharedMounts } = await import(`${REPO}/packages/core/source/session/shared.ts`)
const { createDockerBackend } = await import(`${REPO}/packages/core/source/session/docker-backend.ts`)
const { generateCellId } = await import(`${REPO}/packages/core/source/session/env.ts`)

// 宿主平台由**宿主层**读一次再传下去（见 core 的 `host-platform.ts`）：core 不自己去读
// `process.platform`，所以这个夹具得像产品入口那样读一次。产品里那一处是
// `apps/app/source/main.ts`，这里是它的等价物。少了它，禁挂规则一份都取不到。
const PLATFORM = requireHostPlatform(process.platform)

const env = process.env
const record = {
  run: env.ABX_RUN,
  entries: JSON.parse(env.ABX_ENTRIES),
  source: 'resolve',
  mounts: [],
  rejected: [],
  thrown: null,
  started: false,
  cellId: null,
  exitCode: null,
  stdout: '',
  stderr: '',
}

try {
  if (env.ABX_MOUNTS_FILE) {
    record.mounts = JSON.parse(readFileSync(env.ABX_MOUNTS_FILE, 'utf8')).mounts
    record.source = `pre-resolved:${env.ABX_MOUNTS_FILE}`
  } else {
    const result = resolveSharedMounts(record.entries, {
      platform: PLATFORM,
      homeDir: env.ABX_HOME_DIR,
      instancesRoot: env.ABX_INSTANCES_ROOT,
      requireAtLeastOne: env.ABX_REQUIRE_ONE === '1',
    })
    record.mounts = result.mounts
    record.rejected = result.rejected
  }
} catch (error) {
  // 解析抛异常时**一个容器都不起**：这正是用例 3 要的证据。
  record.thrown = { name: error.name, message: error.message }
}

if (record.mounts.length > 0 && env.ABX_START === '1') {
  record.started = true
  record.cellId = generateCellId('claude')
  const stdout = []
  const stderr = []
  const handle = await createDockerBackend().create(
    {
      cellId: record.cellId,
      agentId: 'claude',
      platform: PLATFORM,
      command: ['sh', '-c', env.ABX_CELL_CMD],
      // 脚本没有终端：照实传 false（产品侧就是靠这个决定加不加 `--tty`）。
      allocateTty: false,
      taskDir: env.ABX_TASK_DIR,
      workdir: '/workspace',
      cellHome: '/home/node',
      env: {},
      forbiddenEnvNames: [],
      limits: { memory: '512m', pids: 128, cpus: 1 },
      image: env.ABX_IMAGE,
      user: env.ABX_USER,
      network: 'none',
      tmpfsSizeMb: 32,
      sharedMounts: record.mounts,
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
  record.exitCode = exit.code
  record.stdout = stdout.join('')
  record.stderr = stderr.join('')
}

writeFileSync(`${env.ABX_WORK_DIR}/shared-run-${env.ABX_RUN}.json`, JSON.stringify(record, null, 2))
process.exit(0)
EOF

jget() { node -e "try{process.stdout.write(String(require('$1')$2))}catch{process.stdout.write('')}"; }

# run_driver <run 序号> <entries JSON> <cell 命令> [额外环境：VAR=VAL ...]
# 额外环境放在**最后**：同名的变量以最后一个为准，调用方才能覆盖 ABX_START 之类。
run_driver() {
  local index="$1" entries="$2" cmd="${3:-}"
  shift 3
  env \
    PATH="$WORK/bin:$PATH" \
    ABX_DOCKER_ARGV_LOG="$WORK/argv-$index.log" \
    ABX_REPO="$REPO" \
    ABX_WORK_DIR="$WORK" \
    ABX_RUN="$index" \
    ABX_ENTRIES="$entries" \
    ABX_CELL_CMD="$cmd" \
    ABX_IMAGE="$IMAGE" \
    ABX_TASK_DIR="$WORK/task" \
    ABX_HOME_DIR="$HOME" \
    ABX_INSTANCES_ROOT="$INSTANCES_ROOT" \
    ABX_USER="$CELL_USER" \
    ABX_START="1" \
    ${@+"$@"} \
    node --import "$WORK/register.mjs" "$WORK/shared-driver.mjs" 2>&1
}

# 那一次跑，docker 收到的 `run` 调用有几条。
docker_runs() { # <argv log>
  [ -f "$1" ] || { printf '0'; return; }
  node -e "const l=require('node:fs').readFileSync('$1','utf8').trim().split('\n').filter((x)=>x!=='').map(JSON.parse);process.stdout.write(String(l.filter((a)=>a[0]==='run').length))"
}

# 打印那一次跑的挂载参数（人看的）。
show_volumes() { # <argv log>
  [ -f "$1" ] || return 0
  node -e "const l=require('node:fs').readFileSync('$1','utf8').trim().split('\n').filter((x)=>x!=='').map(JSON.parse);for(const a of l){if(a[0]!=='run')continue;a.forEach((x,i)=>{if(x==='--volume')console.log('      -v '+a[i+1])})}"
}

hash_of() { node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('$1')).digest('hex'))"; }
nonce()  { node -e "process.stdout.write(require('node:crypto').randomUUID())"; }

ok '驱动器与断言辅助就绪'

# ── 2. 用例 1+2：整挂一个真目录，读得到、写不进 ───────────────────────────
step '2. 用例 1+2：共享一个真目录 → 舱内读得到、内容一致、写不进去'

NOTES="$SHARE/notes"
HOST_HASH="$(hash_of "$NOTES/readme.md")"
NONCE_1="$(nonce)"

CELL_1="$(cat <<'SH'
set -u
echo "--- ls -a /shared"; ls -a /shared
echo "--- ls -a /shared/notes"; ls -a /shared/notes
echo "--- cat /shared/notes/readme.md"; cat /shared/notes/readme.md
echo "--- cat /shared/notes/docs/plan.md"; cat /shared/notes/docs/plan.md
echo "--- sha256"; sha256sum /shared/notes/readme.md | cut -d' ' -f1
echo "--- 目录里新建文件（应该失败）"
if write_error=$({ : > /shared/notes/from-cell.md; } 2>&1); then
  echo "SHARED-WRITE=ALLOWED"
else
  echo "SHARED-WRITE=DENIED $write_error"
fi
echo "--- 改已有文件（应该失败）"
if write_error=$({ printf 'tampered\n' >> /shared/notes/readme.md; } 2>&1); then
  echo "SHARED-EDIT=ALLOWED"
else
  echo "SHARED-EDIT=DENIED $write_error"
fi
echo "--- 任务目录仍然可写（对照组：只有共享区是只读的）"
if printf 'task\n' > /workspace/task-write.txt 2>/dev/null; then echo "TASK-WRITE=OK"; else echo "TASK-WRITE=FAILED"; fi
SH
)"
CELL_1="$CELL_1"$'\n'"echo \"CELL-RAN-NONCE=$NONCE_1\""

ENTRIES_1="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'directory'}]))" "$NOTES")"
run "docker run --rm --read-only ... -v $NOTES:/shared/notes:ro $IMAGE sh -c '<读共享目录 + 试着写>'"
run_driver 'share-1' "$ENTRIES_1" "$CELL_1" | tee "$WORK/out-1.txt" | sed 's/^/  /'

if [ -s "$WORK/shared-run-share-1.json" ]; then
  raw "挂载参数："
  show_volumes "$WORK/argv-share-1.log"
  OUT_1="$(jget "$WORK/shared-run-share-1.json" .stdout)"

  raw "舱内退出码 $(jget "$WORK/shared-run-share-1.json" .exitCode)"
  printf '%s' "$OUT_1" | grep -q "CELL-RAN-NONCE=$NONCE_1" \
    && ok "容器确实执行了舱内命令（nonce $NONCE_1 回声到了 stdout）" \
    || fail '没看到舱内命令的 nonce：容器可能根本没跑起来'

  printf '%s' "$OUT_1" | grep -q 'MARKER-NOTES-README' && ok '共享目录里的文件，舱内读得到' || fail '舱内读不到共享目录里的文件'
  printf '%s' "$OUT_1" | grep -q 'MARKER-NOTES-PLAN' && ok '子目录里的文件也读得到（挂的是整个目录树）' || fail '子目录里的文件读不到'
  printf '%s' "$OUT_1" | grep -q '^\.git$\|\.git' && ok '.git 照常挂进去（「扫描时跳过」不等于「不挂」）' || raw '（注意：舱内没看到 .git）'

  CELL_HASH="$(printf '%s' "$OUT_1" | grep -E '^[0-9a-f]{64}$' | head -1)"
  raw "舱内 sha256 $CELL_HASH"
  raw "宿主 sha256 $HOST_HASH"
  [ -n "$CELL_HASH" ] && [ "$CELL_HASH" = "$HOST_HASH" ] \
    && ok '内容**逐字节**一致（比的是 sha256，不是文件名）' \
    || fail '舱内读到的内容与宿主不一致'

  printf '%s' "$OUT_1" | grep -q 'SHARED-WRITE=DENIED' && ok '舱内建不了新文件' || fail '舱内在共享目录里建出了文件'
  printf '%s' "$OUT_1" | grep -q 'SHARED-EDIT=DENIED' && ok '舱内改不了已有文件' || fail '舱内改动了已有文件'
  printf '%s' "$OUT_1" | grep -q 'Read-only file system' && ok '被拒的原因正是只读文件系统（不是权限位）' || raw '（注意：拒绝原因不是 EROFS，值得看一眼）'
  printf '%s' "$OUT_1" | grep -q 'TASK-WRITE=OK' && ok '对照组成立：任务目录仍然可写，只读的是共享区' || fail '任务目录也写不动了（--read-only 把整个容器顶成了只读）'

  [ -f "$NOTES/from-cell.md" ] && fail '宿主上多出了舱内建的文件' || ok '宿主上没有多出那个文件'
  grep -q 'tampered' "$NOTES/readme.md" && fail '宿主上的文件被舱内改了' || ok '宿主上的文件原样未动'

  VOLUMES="$(show_volumes "$WORK/argv-share-1.log" | tr -d ' ' | tr '\n' ' ')"
  raw "argv 里的挂载：$VOLUMES"
  printf '%s' "$VOLUMES" | grep -q -- "-v$NOTES:/shared/notes:ro" && ok "argv 里是 $NOTES:/shared/notes:ro" || fail 'argv 里没有那一条只读挂载'
  RUNS_1="$(docker_runs "$WORK/argv-share-1.log")"
  [ "$RUNS_1" = "1" ] && ok '这一次只起了一个容器' || fail "这一次的 docker run 有 $RUNS_1 条"
else
  fail '用例 1 没跑出结果'
fi

# ── 3. 用例 3：目录里有 .env → 拒，容器根本没起 ───────────────────────────
step '3. 用例 3：共享一个装着 .env 的目录 → 拒绝，且**容器根本没起**'

ENTRIES_DIRTY="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'directory'}]))" "$SHARE/dirty")"
run "resolveSharedMounts([$SHARE/dirty], { requireAtLeastOne: true })    # 期望抛 MountPolicyViolation"

# ABX_START=1 也起不来：解析抛了异常，驱动器一个容器都不会起。
run_driver 'dirty' "$ENTRIES_DIRTY" 'echo SHOULD-NOT-RUN' ABX_REQUIRE_ONE=1 | sed 's/^/  /'

THROWN="$(jget "$WORK/shared-run-dirty.json" .thrown.message)"
NOT_STARTED="$(jget "$WORK/shared-run-dirty.json" .started)"
DIRTY_RUNS="$(docker_runs "$WORK/argv-dirty.log")"

if [ -n "$THROWN" ] && [ "$THROWN" != "null" ]; then
  raw "抛出来的原话（前两行）："
  printf '%s' "$THROWN" | head -2 | while read -r line; do raw "$line"; done
  printf '%s' "$THROWN" | grep -q '\.env' && ok '拒绝理由**点名了 .env**' || fail '理由里没点名 .env'
  printf '%s' "$THROWN" | grep -q '只能往上加' && ok '理由解释了「嵌套挂载只能加不能减」——为什么拒整个目录' || fail '理由没解释为什么拒整个目录'
  printf '%s' "$THROWN" | grep -q 'MountPolicyViolation\|至少挂一个' && ok '抛的是策略违规（要求至少挂一个，却一个都没挂上）' || raw '（注意：抛的不是 MountPolicyViolation）'
else
  fail '没有抛异常：一条都没挂上还照常起舱，用户会以为共享成功了'
fi

[ "$NOT_STARTED" = "false" ] && ok '那次跑没有起容器（started=false）' || fail '居然起了容器'
[ "$DIRTY_RUNS" = "0" ] && ok 'docker 调用记录里一条 run 都没有：容器**根本没起**' || fail "docker 收到了 $DIRTY_RUNS 条 run"
[ -f "$WORK/argv-dirty.log" ] && fail '那次跑调用过 docker（不该调用）' || ok '那次跑没有调用过 docker'

# ── 4. 用例 4：软链按目标判定；实例目录不许当共享源 ───────────────────────
step '4. 用例 4：软链按**目标**判定（看着正常的链接不作数）'

check_rejected() { # <run 序号> <entries JSON> <期望理由里的关键词…>
  local index="$1" entries="$2"; shift 2
  run_driver "$index" "$entries" '' | sed 's/^/  /'
  local reason
  reason="$(jget "$WORK/shared-run-$index.json" '.rejected[0].reason')"
  raw "理由：$reason"
  [ "$(jget "$WORK/shared-run-$index.json" '.mounts.length')" = "0" ] && ok '没有算出任何挂载' || fail '居然算出挂载了'
  for keyword in "$@"; do
    printf '%s' "$reason" | grep -q "$keyword" && ok "理由里说了「$keyword」" || fail "理由里没提「$keyword」"
  done
  [ "$(docker_runs "$WORK/argv-$index.log")" = "0" ] && ok '没有被拒还起容器' || fail '被拒了还起了容器'
}

ENTRIES_LINK_HOME="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'directory'}]))" "$SHARE/links/home")"
ENTRIES_LINK_ENV="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'file'}]))" "$SHARE/links/env")"
ENTRIES_INSTANCE="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'directory'}]))" "$INSTANCES_ROOT/claude/claude")"

raw "素材 $SHARE/links/home → $HOME（链接本身在临时目录里，看着人畜无害）"
check_rejected 'link-home' "$ENTRIES_LINK_HOME" '是符号链接' 'home'
raw "素材 $SHARE/links/env → $SHARE/outside/.env（共享目录之外的凭据文件）"
check_rejected 'link-env' "$ENTRIES_LINK_ENV" '是符号链接' '凭据文件'
raw "素材 $INSTANCES_ROOT/claude/claude（abx 自己造的可写地）"
check_rejected 'instance' "$ENTRIES_INSTANCE" '实例状态目录'

# 被拒的那一条在「要求至少挂一个」时要把每一条的原因带进异常里。
run_driver 'link-home-required' "$ENTRIES_LINK_HOME" '' ABX_REQUIRE_ONE=1 | sed 's/^/  /'
THROWN_LINK="$(jget "$WORK/shared-run-link-home-required.json" .thrown.message)"
printf '%s' "$THROWN_LINK" | grep -q '是符号链接' && ok '要求至少挂一个时，异常里带着「是符号链接，按目标判定」' || fail '异常里没说明它是符号链接'
[ "$(docker_runs "$WORK/argv-link-home-required.log")" = "0" ] && ok '全被拒时容器不会起' || fail '全被拒还是起了容器'

# ── 5. 用例 5：重名往后排 -2，两个都在 ────────────────────────────────────
step '5. 用例 5：两个都叫 notes → /shared/notes 与 /shared/notes-2，两个都在'

OTHER_NOTES="$SHARE/other/notes"
NONCE_5="$(nonce)"
ENTRIES_DUPE="$(node -e "process.stdout.write(JSON.stringify([{path:process.argv[1],kind:'directory'},{path:process.argv[2],kind:'directory'}]))" "$NOTES" "$OTHER_NOTES")"

CELL_5="$(cat <<'SH'
set -u
echo "--- ls /shared"; ls -a /shared
echo "--- cat /shared/notes/readme.md"; cat /shared/notes/readme.md
echo "--- cat /shared/notes-2/readme.md"; cat /shared/notes-2/readme.md
echo "--- 两个是两份不同的东西"
if [ "$(cat /shared/notes/readme.md)" = "$(cat /shared/notes-2/readme.md)" ]; then echo "DUPLICATE=SAME"; else echo "DUPLICATE=DISTINCT"; fi
SH
)"
CELL_5="$CELL_5"$'\n'"echo \"CELL-RAN-NONCE=$NONCE_5\""

run "docker run ... -v $NOTES:/shared/notes:ro -v $OTHER_NOTES:/shared/notes-2:ro ..."
run_driver 'dupe' "$ENTRIES_DUPE" "$CELL_5" | tee "$WORK/out-5.txt" | sed 's/^/  /'

if [ -s "$WORK/shared-run-dupe.json" ]; then
  show_volumes "$WORK/argv-dupe.log"
  TARGETS="$(jget "$WORK/shared-run-dupe.json" '.mounts.map((m)=>m.target).join(" ")')"
  raw "算出来的挂载点：$TARGETS"
  [ "$TARGETS" = "/shared/notes /shared/notes-2" ] && ok '第二个排到了 /shared/notes-2（撞车意味着后一个把前一个盖掉）' || fail "挂载点是 $TARGETS"

  OUT_5="$(jget "$WORK/shared-run-dupe.json" .stdout)"
  printf '%s' "$OUT_5" | grep -q "CELL-RAN-NONCE=$NONCE_5" && ok '容器确实执行了舱内命令' || fail '容器没跑起来'
  printf '%s' "$OUT_5" | grep -q 'MARKER-NOTES-README' && ok '第一个目录在 /shared/notes 里' || fail '第一个目录不见了'
  printf '%s' "$OUT_5" | grep -q 'MARKER-OTHER-NOTES' && ok '第二个目录在 /shared/notes-2 里（没被盖掉）' || fail '第二个目录不见了'
  printf '%s' "$OUT_5" | grep -q 'DUPLICATE=DISTINCT' && ok '两份内容各是各的，确实是两个目录' || fail '两个挂载点读到了同一份内容'
else
  fail '用例 5 没跑出结果'
fi

# ── 6. 用例 6：整目录绑定，不是快照 ───────────────────────────────────────
step '6. 用例 6：挂载清单算好之后**再**放进去的文件，舱内立刻看得到'

LATER="$NOTES/added-later.txt"
NONCE_6="$(nonce)"

raw '6a. 先解析（此刻 added-later.txt 还不存在），但**不起容器**'
run_driver 'later-resolve' "$ENTRIES_1" '' ABX_START=0 | sed 's/^/  /'
MOUNTS_6="$(jget "$WORK/shared-run-later-resolve.json" '.mounts.length')"
[ "$MOUNTS_6" = "1" ] && ok '算出来一条挂载（整挂目录，所以只有一条）' || fail "算出来 $MOUNTS_6 条挂载"

raw "6b. 宿主上往 $NOTES 里放一个新文件"
printf 'MARKER-ADDED-LATER\n' > "$LATER"
ls -la "$NOTES" | sed 's/^/    /'

CELL_6="$(cat <<'SH'
set -u
echo "--- cat /shared/notes/added-later.txt（挂载清单是在它出现之前算的）"
cat /shared/notes/added-later.txt || echo "ADDED-LATER=UNREADABLE"
echo "--- ls /shared/notes"; ls -a /shared/notes
SH
)"
CELL_6="$CELL_6"$'\n'"echo \"CELL-RAN-NONCE=$NONCE_6\""

raw '6c. 用**那份先算好的清单**起容器'
run "docker run ... -v $NOTES:/shared/notes:ro ...   # 清单来自 6a，不是现在重算的"
run_driver 'later-run' "$ENTRIES_1" "$CELL_6" ABX_MOUNTS_FILE="$WORK/shared-run-later-resolve.json" | tee "$WORK/out-6.txt" | sed 's/^/  /'

if [ -s "$WORK/shared-run-later-run.json" ]; then
  show_volumes "$WORK/argv-later-run.log"
  raw "这一份清单来自：$(jget "$WORK/shared-run-later-run.json" .source)"
  OUT_6="$(jget "$WORK/shared-run-later-run.json" .stdout)"
  printf '%s' "$OUT_6" | grep -q "CELL-RAN-NONCE=$NONCE_6" && ok '容器确实执行了舱内命令' || fail '容器没跑起来'
  printf '%s' "$OUT_6" | grep -q 'MARKER-ADDED-LATER' \
    && ok '后放进来的文件立刻可见：挂的是**整个目录**，不是拖进来那一刻的快照' \
    || fail '后放进去的文件看不见——这是「按文件展开」的实现才会有的失败'
  [ "$(docker_runs "$WORK/argv-later-run.log")" = "1" ] && ok '6c 起了容器（6a 没有起）' || fail '6c 的 docker run 条数不对'
  [ "$(docker_runs "$WORK/argv-later-resolve.log")" = "0" ] && ok '6a 没有起容器（只解析）' || fail '6a 居然起了容器'
else
  fail '用例 6 没跑出结果'
fi

# ── 7. 收尾：容器一个都不许留下 ───────────────────────────────────────────
step '7. 收尾：容器退出即销毁'

LEFT_ANY=0
for record in "$WORK"/shared-run-*.json; do
  [ -f "$record" ] || continue
  CELL_ID="$(jget "$record" .cellId)"
  [ -z "$CELL_ID" ] || [ "$CELL_ID" = "null" ] && continue
  LEFT="$(docker ps -a --filter "label=abx.cell-id=$CELL_ID" --format '{{.Names}}' 2>/dev/null)"
  if [ -n "$LEFT" ]; then
    fail "容器没被销毁：$LEFT"
    LEFT_ANY=1
  fi
done
[ "$LEFT_ANY" = "0" ] && ok '跑过的容器一个都没留下（--rm 生效）'

# 素材是脚本自己造的，只检查「共享的目录里没有多出舱内写的东西」。
[ -f "$LATER" ] && ok '宿主上的素材目录里只有脚本自己放的那个文件' || fail '素材目录被动过'

# ── 结果 ──────────────────────────────────────────────────────────────────
step '结果'

if [ "$FAILED" = "0" ]; then
  printf '  \033[32m全部硬断言通过。\033[0m\n'
  printf '  验的是：整挂可读且逐字节一致 · 共享区只读而任务目录仍可写 · 带 .env 的目录被拒且容器没起 ·\n'
  printf '          软链按目标判定 · 重名排到 -2 且两个都在 · 挂载清单算好之后新增的文件立刻可见。\n'
  exit 0
fi

printf '  \033[31m有硬断言没过，见上面的 ✗。\033[0m\n'
exit 1
