/**
 * 共享条目 → 舱内**只读**挂载。
 *
 * 这是「拖进面板的东西真的出现在舱内」那条链的第二半（第一半是宿主把路径 stat 出来，
 * 见 `apps/app`）。它只做一件事：把一批条目算成挂载清单，把算不出来的那些连理由
 * 一起退回去。
 *
 * 几条不能让步的规则，每条都对应一种会**悄无声息**出事的方式：
 *
 *   1. **目录整挂，绝不拆成一个个文件。** 拆开有两个后果，都是静默的：
 *      1000 个文件就是 1000 条 `-v` 参数；更要命的是**目录里新增的文件永远不出现**
 *      ——用户以为共享的是一个目录，实际拿到的是拖进来那一刻的快照。
 *   2. **舱内路径由这一层算，调用方给不了。** 目标是 `/shared/<basename>`，重名往后
 *      排 `-2` / `-3`。让调用方指定挂载点，等于把「往舱内哪个位置放东西」这件事
 *      交给了外面，而那正是最容易被写错的一处。
 *   3. **先 `realpath` 再判前缀。** 不解析软链的话，`~/notes` 这个看着正常的目录
 *      可以是指向 `~/.ssh` 的链接，前缀规则一个字都拦不住。
 *   4. **目录要扫凭据文件，命中就拒整个目录。** 嵌套挂载只能「加」不能「减」：
 *      目录整挂之后，舱内看到的就是宿主上那一整个目录。静默少挂几个文件、
 *      用户以为共享了整个目录，比直接拒绝危险得多。
 *   5. **一条坏条目不抛异常。** 会话不该因为一个被删掉的目录起不来。被拒的条目
 *      连同理由返回给调用方；只有「一条都没挂上、而调用方要求至少挂一个」时才是错。
 *
 * 与 `mount-policy.ts` 的关系：那边是**闸门**（起容器前对整份挂载清单再判一次），
 * 这边是**构造**（把条目算成清单）。两边共用同一套禁挂前缀与凭据规则——构造时就
 * 拒掉的东西，不会走到闸门那一步。
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SharedEntry, SharedEntryKind, SharedEntryRejection } from '@abx/contracts'
import type { SandboxMount } from './backend'
import { defaultInstancesRoot } from './instance'
import {
  FORBIDDEN_INSTANCE_ROOT_SUBDIRS,
  FORBIDDEN_MOUNT_PREFIXES,
  MountPolicyViolation,
  SHARED_CELL_ROOT,
  isAncestor,
  isUnder,
  matchCredentialFileRule,
} from './mount-policy'

/**
 * 扫一个目录时最多看多少个条目。
 *
 * 上界不是性能优化，是**防呆**：共享一个几百万文件的目录时，扫完要几分钟，
 * 期间面板毫无反应。超了就报错让用户缩小范围——**不许**扫到一半就停然后当作没事，
 * 那正是「静默少挂几个文件」的另一个版本。
 */
export const MAX_SHARED_SCAN_ENTRIES = 20_000

/** 被拒时最多列几个命中凭据规则的文件，其余的只给总数。 */
export const MAX_REPORTED_CREDENTIAL_FILES = 10

/**
 * 共享源额外禁掉的前缀：`FORBIDDEN_MOUNT_PREFIXES` 的补充，只作用于共享。
 *
 * `/run` 这一条是**实测**踩出来的：docker socket 的父目录在名单里写的是 `/var/run`，
 * 而在相当多的 Linux 上 `/var/run` 就是 `/run` 的软链。判 realpath 之后，
 * `/run` 一个前缀都对不上，于是「docker socket 的父目录不许共享」这条闸门
 * 形同不存在——舱内拿到 `/run` 就拿到了 `/run/docker.sock`。
 *
 * 放在这里而不是并进 `FORBIDDEN_MOUNT_PREFIXES`：那个名单还被挂载闸门与实例根用着，
 * 动它要重新论证另外两处的后果；而这一条只需要对共享成立就够了。
 */
export const EXTRA_FORBIDDEN_SHARED_PREFIXES: readonly string[] = ['/run']

/**
 * 扫描时整个跳过的目录名。
 *
 * 只有 `.git`。理由跟安全无关：一个仓库的 `.git` 能有几万个对象文件，足以把上界
 * 无意义地打满，而它里面不可能躺着 `.env` 这类东西（那在工作区里，不在对象库里）。
 * 别的目录名一概不跳——跳过就等于「不扫」，而不扫就没法证明里面没凭据。
 */
export const SHARED_SCAN_SKIPPED_DIRS: readonly string[] = ['.git']

export interface ResolveSharedMountsOptions {
  /** 舱内共享区根，默认 `/shared`。 */
  readonly cellRoot?: string
  /** 宿主 home，默认 `os.homedir()`。测试里覆盖它，免得跟着跑测试的人的主目录走。 */
  readonly homeDir?: string
  /** 实例根，默认 `ABX_INSTANCES_ROOT` / `~/.abx/instances`。用来判「和实例目录互斥」。 */
  readonly instancesRoot?: string
  /**
   * 要求「至少挂上一个」。默认 `false`：一条都没挂上不该让会话起不来。
   *
   * 真正起会话的那一层应该传 `true`——用户拖了东西进来，结果一个都没挂上却照常
   * 起舱，是最坏的一种失败（他以为共享了）。面板那一侧不传：拖进一个被拒的条目
   * 只需要在列表下面给一行原因。
   */
  readonly requireAtLeastOne?: boolean
  /** 扫描上界，默认 `MAX_SHARED_SCAN_ENTRIES`。 */
  readonly maxScanEntries?: number
}

export interface ResolveSharedMountsResult {
  /** 只读挂载，顺序与 `entries` 一致（被拒的那些跳过）。 */
  readonly mounts: readonly SandboxMount[]
  /** 没进共享区的条目与理由。调用方决定怎么呈现，不该因此起不来。 */
  readonly rejected: readonly SharedEntryRejection[]
}

/**
 * 宿主上的这个路径现在是什么。
 *
 * 这是 `kind` **唯一**的权威来源：界面拖放那一刻的 `webkitGetAsEntry` 只是预览，
 * 它看不见软链、也没法在条目已经不在的时候说清是什么。返回 `null` 表示宿主上
 * 找不到（或不是文件/目录），宿主拿它标 `missing`。
 */
export function inspectSharedEntry(hostPath: string): SharedEntry | null {
  try {
    // statSync（不是 lstat）：软链按**目标**判定，与挂载时用的是同一个视角。
    const stat = statSync(hostPath)
    if (stat.isDirectory()) return { path: hostPath, kind: 'directory' }
    if (stat.isFile()) return { path: hostPath, kind: 'file' }
    return null
  } catch {
    return null
  }
}

/**
 * 把一批共享条目算成只读挂载。
 *
 * `entries` 里的 `kind` **不参与判定**——它以宿主 stat 的结果为准（见
 * `inspectSharedEntry`）。这样「调用方谎报 kind」这件事在结构上就不可能生效。
 */
export function resolveSharedMounts(entries: readonly SharedEntry[], options: ResolveSharedMountsOptions = {}): ResolveSharedMountsResult {
  const context: ResolveContext = {
    cellRoot: normalizeCellRoot(options.cellRoot ?? SHARED_CELL_ROOT),
    homeDir: realpathBestEffort(options.homeDir ?? homedir()),
    instancesRoot: realpathBestEffort(options.instancesRoot ?? defaultInstancesRoot()),
    maxScanEntries: options.maxScanEntries ?? MAX_SHARED_SCAN_ENTRIES,
    usedNames: new Set<string>(),
  }

  const mounts: SandboxMount[] = []
  const rejected: SharedEntryRejection[] = []

  for (const [index, entry] of entries.entries()) {
    const outcome = resolveOne(entry, index, context)
    if (outcome.mount !== undefined) mounts.push(outcome.mount)
    else rejected.push({ path: entry.path, reason: outcome.reason })
  }

  if (options.requireAtLeastOne === true && mounts.length === 0) {
    throw new MountPolicyViolation(
      `共享区一个条目都没挂上（共 ${entries.length} 条），而调用方要求至少挂一个：` +
        `照常起舱会得到一个「用户以为共享了、其实什么都没有」的会话，所以这里直接拒绝。\n` +
        (rejected.length === 0
          ? '  - （一个条目都没传进来）'
          : rejected.map((item) => `  - ${item.path}：${item.reason}`).join('\n')),
    )
  }

  return { mounts, rejected }
}

interface ResolveContext {
  readonly cellRoot: string
  readonly homeDir: string
  readonly instancesRoot: string
  readonly maxScanEntries: number
  readonly usedNames: Set<string>
}

type ResolveOutcome = { readonly mount: SandboxMount; readonly reason?: undefined } | { readonly mount?: undefined; readonly reason: string }

/**
 * 一条条目走完全部闸门。
 *
 * 顺序是**便宜的先判、结论最具体的先说**，与 `assertMountPolicy` 同一套语言：
 * 形状 → 能不能解析 → 凭据文件名 → 禁挂路径 → 目录内容 → 挂载点。
 * 一个同时犯了两个错的条目，用户最需要看到的是「这是凭据文件」或「你挂到 /etc 去了」，
 * 而不是「名字不合法」——后者他没法照着改。
 */
function resolveOne(entry: SharedEntry, index: number, context: ResolveContext): ResolveOutcome {
  const raw = typeof entry.path === 'string' ? entry.path : ''

  if (raw.trim() === '') return { reason: '路径是空的。' }
  if (!path.isAbsolute(raw)) {
    return { reason: `不是绝对路径（${raw}）：相对路径指的是哪儿，取决于谁在什么目录下跑，挂载不能建在这上面。` }
  }
  // `..` 能把一个人畜无害的路径变成 `/home`。契约层已经拦过一次，这里再拦一次：
  // `resolveSharedMounts` 是可以被直接调用的（CLI、测试、将来的会话编排），
  // 不能假设每个调用方都先过了 schema。
  if (raw.split(path.sep).includes('..')) {
    return { reason: `路径里出现了 ..（${raw}）：它能把一个看起来正常的路径变成宿主的任意位置。` }
  }

  const literal = path.resolve(raw)
  const link = isSymbolicLink(literal)
  // 软链条目的拒稿理由都要带上这句：用户拖的是一个链接，判的却是链接指向的东西，
  // 不说明的话他会觉得自己那个路径明明没问题。
  const reject = (base: string): ResolveOutcome => ({
    reason: link ? `这是符号链接，按它解析后的目标判定：${base}` : base,
  })

  const resolved = realpathOrNull(literal)
  if (resolved === null) {
    return reject(`宿主上找不到（${literal}），或者权限不够读不到：一个挂不上的共享条目必须被拒，不能当它不存在。`)
  }

  // 凭据文件名先判：`~/.claude/.credentials.json` 与它隔壁的配置文件共享同一个前缀，
  // 前缀规则区分不了它们，只有名字规则可以。
  const credentialRule = matchCredentialFileRule(resolved)
  if (credentialRule !== null) {
    return reject(
      `这是凭据文件（命中规则 ${credentialRule}）：舱内永远拿不到真凭据，` +
        `要共享的是工作用的文件，不是身份。`,
    )
  }

  // 字面路径与解析后的路径**都要过闸**，两道都要。
  //
  // 只判解析后的结果是错的：`/var/run` 在相当多的系统上是 `/run` 的软链，而禁挂前缀
  // 里写的是 `/var/run`——解析之后一个前缀都对不上，于是「docker socket 的父目录」
  // 这条闸门整个失效。反过来只判字面路径也不行：`~/notes` 可以是指向 `~/.ssh` 的链接。
  // 这跟 `assertOneStateDir` 是同一种写法：先字面、再 realpath。
  const violation = sharedSourceViolationReason(literal, context) ?? sharedSourceViolationReason(resolved, context)
  if (violation !== null) return reject(violation)

  const kind = kindOf(resolved)
  if (kind === null) {
    return reject(`既不是普通文件也不是目录（${resolved}）：套接字、设备文件这类东西不进舱。`)
  }

  if (kind === 'directory') {
    const scan = scanDirectory(resolved, context.maxScanEntries)
    if (scan.exceeded) {
      return reject(
        `目录里的条目超过 ${context.maxScanEntries} 个，扫到上界就停了（已扫 ${scan.visited} 个）：` +
          `共享一个这么大的目录没有意义，而且扫不完就没法确认里面有没有凭据文件。请共享它下面更具体的子目录。`,
      )
    }
    if (scan.unreadable.length > 0) {
      return reject(
        `目录里有读不动的子目录（${scan.unreadable.slice(0, MAX_REPORTED_CREDENTIAL_FILES).join(', ')}）：` +
          `读不动就没法确认里面没有凭据文件，所以按「扫不干净」处理，失败关闭。`,
      )
    }
    if (scan.total > 0) return reject(credentialDirectoryReason(scan))
  }

  // 目标路径由这一层算：`/shared/<name>`，重名往后排。调用方给不了。
  const name = allocateName(resolved, index, context.usedNames)
  return { mount: { source: resolved, target: `${context.cellRoot}/${name}`, mode: 'ro' } }
}

/** `sharedSourceViolationReason` 的判据：宿主 home 与实例根。 */
export interface SharedSourceContext {
  readonly homeDir: string
  readonly instancesRoot: string
}

/**
 * 这个宿主路径能不能当共享源；不能就是理由，能就是 `null`。
 *
 * 每一条都对应一种具体的逃逸，顺序与 `assertInstancesRoot` 一致：
 *
 * 传进来的路径调用方要**保证已经 realpath 过，或者至少是 resolved**：这里的比较
 * 全是字符串前缀。调用点（`resolveOne`）两道都判——字面路径一道、解析后一道。
 *
 *   - 文件系统的根：挂进去等于把整块盘交出去；
 *   - 宿主 home **本身**（或它的上级）：共享要指到主目录下面的某个具体目录；
 *   - 与实例根**互斥**：共享源不许是实例根的祖先或后代。共享是用户的东西，
 *     实例状态目录是 abx 自己造的可写地，两者重叠就是「用户能读到、甚至改到
 *     会话历史」；
 *   - 主目录下的那几处身份目录（`.ssh` / `.aws` / `.kube` / `.claude`……）：
 *     `FORBIDDEN_MOUNT_PREFIXES` 里的 `/home` 在这里必须让开（否则共享根本用不了），
 *     让开之后这几处就没人拦了，所以单列一条；
 *   - 其余禁挂前缀照旧（`/etc` `/proc` `/sys` `/dev` `/root` `/var/run`……）。
 *
 * **口子只开到「home 下的某个子目录」**，home 根本身与更上一级都还是拒的——
 * 这是共享与配置文件这两件事必须分开的地方：对配置文件来说 `/home` 这条前缀是对的，
 * 对共享目录来说它太宽了（用户的项目就住在主目录下面）。
 */
export function sharedSourceViolationReason(resolved: string, context: SharedSourceContext): string | null {
  const { homeDir, instancesRoot } = context

  if (resolved === path.parse(resolved).root) {
    return `它是文件系统的根（${resolved}）：挂进去等于把宿主整块盘交给舱内。`
  }

  if (resolved === homeDir || isAncestor(resolved, homeDir)) {
    return (
      `它是宿主 home（${homeDir}）本身，或者是它的上级：共享要指到主目录下面的**某个具体目录**，` +
      `而不是整个主目录。`
    )
  }

  if (isUnder(resolved, instancesRoot) || isAncestor(resolved, instancesRoot)) {
    return (
      `它和实例状态目录（${instancesRoot}）重叠：那里是 abx 自己造的可写地（会话历史、生成的配置），` +
      `共享源不许是它的祖先或后代。`
    )
  }

  if (isUnder(resolved, homeDir)) {
    const sensitive = FORBIDDEN_INSTANCE_ROOT_SUBDIRS.find((name) => isUnder(resolved, path.join(homeDir, name)))
    if (sensitive !== undefined) {
      return (
        `它在主目录的 ${sensitive}/ 下面：那里的东西读得到就等于拿到了身份（私钥、云凭据、kubeconfig、` +
        `agent 自己的登录态），不能共享给舱内。请共享工作用的目录。`
      )
    }
  }

  // 禁挂前缀里，home 那一条（以及它的上级）要**让开**——共享源本来就在主目录下面。
  // 让开之后剩下的（/etc、/var/run、/proc、/root……）一条都不放。
  const prefix = [...FORBIDDEN_MOUNT_PREFIXES, ...EXTRA_FORBIDDEN_SHARED_PREFIXES].find(
    (candidate) => candidate !== homeDir && !isAncestor(candidate, homeDir) && isUnder(resolved, candidate),
  )
  if (prefix !== undefined) {
    return `它落在禁挂前缀 ${prefix} 里：那里是宿主自己的东西（系统配置、内核接口、docker socket），不进舱。`
  }

  return null
}

/** `statSync` 之后的类型；既不是普通文件也不是目录就是 `null`。 */
function kindOf(resolved: string): SharedEntryKind | null {
  try {
    const stat = statSync(resolved)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

interface CredentialHit {
  /** 相对共享目录的路径。**相对**而不是绝对：用户要对得上自己那个目录里的东西。 */
  readonly relativePath: string
  readonly rule: string
}

interface CredentialScanResult {
  readonly hits: readonly CredentialHit[]
  /** 命中总数。`hits` 只留前几个，总数照样要说出来。 */
  readonly total: number
  readonly visited: number
  readonly exceeded: boolean
  /** 读不动的子目录（相对路径）。失败关闭用，见调用点。 */
  readonly unreadable: readonly string[]
}

/**
 * 扫一个目录，找凭据文件。
 *
 * 三个刻意的选择：
 *   - **不跟随目录内的符号链接**（只按 `dirent` 判类型）：跟着走既可能绕出这个目录，
 *     也可能成环。名字该不该拒还是按名字判，与类型无关。
 *   - **`.git` 整个跳过**，理由是它能把上界打满，与安全无关。
 *   - **读不动的目录算命中**（失败关闭）：证明不了「里面没有凭据」和「里面有凭据」
 *     在这里是同一个结论——都不能挂。
 */
function scanDirectory(root: string, maxEntries: number): CredentialScanResult {
  const stack: string[] = [root]
  const hits: CredentialHit[] = []
  const unreadable: string[] = []
  let total = 0
  let visited = 0

  while (stack.length > 0) {
    const directory = stack.pop()
    if (directory === undefined) break

    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch {
      unreadable.push(relativeTo(root, directory))
      continue
    }

    for (const dirent of dirents) {
      visited += 1
      if (visited > maxEntries) return { hits, total, visited, exceeded: true, unreadable }

      const full = path.join(directory, dirent.name)
      const rule = matchCredentialFileRule(dirent.name)
      if (rule !== null) {
        total += 1
        if (hits.length < MAX_REPORTED_CREDENTIAL_FILES) hits.push({ relativePath: relativeTo(root, full), rule })
      }
      if (dirent.isDirectory() && !SHARED_SCAN_SKIPPED_DIRS.includes(dirent.name)) stack.push(full)
    }
  }

  return { hits, total, visited, exceeded: false, unreadable }
}

/**
 * 目录里扫出凭据文件时的理由。
 *
 * 这里必须把「为什么是拒整个目录、而不是少挂那几个文件」写清楚：
 * 用户看到的是一句他没法照做的提示（那个目录在他看来完全正常），
 * 不解释的话他大概率会去找一个更宽的共享方式——而那个方式通常是把整个主目录挂进去。
 */
function credentialDirectoryReason(scan: CredentialScanResult): string {
  const listed = scan.hits.map((hit) => `${hit.relativePath} 命中 ${hit.rule}`).join('，')
  const rest = scan.total - scan.hits.length
  const more = rest > 0 ? `，另有 ${rest} 个` : ''
  return (
    `目录里有凭据文件：${listed}${more}（共 ${scan.total} 个）。整个目录被拒绝，` +
    `因为目录是**整体**挂载的：舱内看到的就是宿主上这一整个目录，` +
    `而嵌套挂载只能往上加、减不掉——藏不住。` +
    `静默地少挂几个文件、让你以为整个目录都共享了，比直接拒绝危险得多。` +
    `请把要共享的东西挪到一个干净的目录，或者改用单文件共享。`
  )
}

/**
 * 舱内那个名字：`basename` 消毒之后再去重。
 *
 * 消毒的是**能当一段路径用**这件事：不许含分隔符、不许是 `.` / `..`、不许含控制字符
 * （控制字符能骗过终端显示，而挂载点是会被打进日志和审计的）。空或异常就用
 * `shared-<序号>` 兜底——序号取条目在**这一批里的位置**，所以同一批 entries
 * 每次算出来的名字都一样。
 *
 * 重名往后排 `-2` / `-3`：两个不同的目录叫 `notes` 是常态（`a/notes` 与 `b/notes`），
 * 而挂载点撞车意味着后一个把前一个盖掉，舱内只剩一个。
 */
function allocateName(resolved: string, index: number, used: Set<string>): string {
  const base = safeBaseName(resolved, index)
  let name = base
  let suffix = 2
  while (used.has(name)) {
    name = `${base}-${suffix}`
    suffix += 1
  }
  used.add(name)
  return name
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function safeBaseName(resolved: string, index: number): string {
  // 两种分隔符都切：路径来自拖放，来源平台不一定跟宿主一样。
  const segments = resolved.split(/[/\\]/)
  const last = segments[segments.length - 1] ?? ''
  if (last === '' || last === '.' || last === '..') return `shared-${index + 1}`
  if (last.includes('/') || last.includes('\\')) return `shared-${index + 1}`
  if (CONTROL_CHARACTERS.test(last)) return `shared-${index + 1}`
  return last
}

function normalizeCellRoot(cellRoot: string): string {
  const trimmed = cellRoot.replace(/\/+$/, '')
  return trimmed === '' ? SHARED_CELL_ROOT : trimmed
}

function relativeTo(root: string, target: string): string {
  const relative = path.relative(root, target)
  return relative === '' ? path.basename(target) : relative
}

/** 这一条路径**本身**是不是软链。`lstat` 失败（不存在）就是 `false`。 */
function isSymbolicLink(literal: string): boolean {
  try {
    return lstatSync(literal).isSymbolicLink()
  } catch {
    return false
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/**
 * 尽量解析软链，路径还不存在时也给出一个**可比较**的结果。
 *
 * 用在 home 与实例根上，两者都要跟「条目解析软链之后的样子」比。
 * `~/.abx/instances` 平时是存在的，但第一次跑之前不存在；这时直接退回字面路径是不行的
 * ——在 `/tmp` → `/private/tmp` 这种地方，字面路径和解析后的路径不是同一个字符串，
 * 两边格式不一致的话「互斥」那条闸门会**静默失效**。所以改成解析它能解析的最深那一层，
 * 再把剩下的接回去。
 */
function realpathBestEffort(target: string): string {
  const literal = path.resolve(target)
  const resolved = realpathOrNull(literal)
  if (resolved !== null) return resolved
  const parent = path.dirname(literal)
  if (parent === literal) return literal
  return path.join(realpathBestEffort(parent), path.basename(literal))
}
