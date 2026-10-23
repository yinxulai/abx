/**
 * 宿主平台：名字在这里写一遍，由它推出的路径规则也在这里。
 *
 * **为什么要有这个文件。** 这套东西里的路径分两种，它们在 Windows 上是两套完全
 * 不同的规矩，而 2026-10-23 之前代码把它们当成了同一种：
 *
 *   - **宿主路径**：任务目录、实例根、共享源……它们在**哪台机器上跑**就长哪样。
 *     `C:\Users\me\proj` 与 `/home/me/proj` 的分隔符、大小写敏感性、绝对路径的
 *     写法都不一样。
 *   - **舱内路径**：`/home/node/.claude`、`/workspace`、`/shared/<名字>`。它们永远
 *     是 Linux 容器里的路径，**与宿主是什么系统无关**，所以永远按 POSIX 判
 *     （见 `session/cell-path.ts`）。
 *
 * 把宿主路径按 POSIX 的规矩判，在 Linux/macOS 上看不出任何问题；到了 Windows 上
 * 表现是**闸门静默失效**——禁挂前缀名单里写的是 `/home`、`/etc`，而 Windows 上的
 * 路径是 `C:\Users\...`，一个都对不上，「主目录不许挂」这条闸门于是形同不存在。
 * 这类失败不会报错，只会让隔离悄悄消失，所以必须靠**分平台**的规则挡住。
 *
 * **为什么是显式传进去的平台值，而不是各处直接读 `process.platform`。**
 * 开发机是 Linux，而目标平台是 macOS 与 Windows：直接读 `process.platform` 的话，
 * 「Windows 上的规则对不对」这件事只能在 Windows 上验，而那台机器恰恰不在手上。
 * 把平台当成一个参数之后，Linux 上就能把 win32 的那套规则**完整跑一遍**——
 * 这是唯一能写出断言的办法。`process.platform` 只在宿主层（`apps/app`）读一次，
 * 再往下传（见 `session/commands/runtime.ts` 的 `resolveContext`）。
 *
 * **不认识的平台一律拒绝**，不是放行：`hostPathRulesFor()` 认不出就抛。
 * 一份「认不出平台、于是按最宽松的方式放行」的路径策略，在真出事的时候
 * 表现得和没有策略一模一样。
 */

import path from 'node:path'

/** 认得的宿主平台。加一个就必须同时在下面给出它的路径规则。 */
export const HOST_PLATFORMS = ['darwin', 'linux', 'win32'] as const

export type HostPlatform = (typeof HOST_PLATFORMS)[number]

/** 这个值认不认得。认不出就是 `null`——调用方必须自己决定怎么拒绝。 */
export function parseHostPlatform(value: unknown): HostPlatform | null {
  if (typeof value !== 'string') return null
  return (HOST_PLATFORMS as readonly string[]).includes(value) ? (value as HostPlatform) : null
}

/**
 * 禁挂前缀：任何挂载源落在这下面都不行（POSIX 那一份）。
 *
 * 每一条都对应一类具体的逃逸：
 *   - `/home` `/root`：SSH 私钥、`~/.aws`、`~/.config/gh`、浏览器数据；
 *   - `/etc`：`/etc/passwd`、`/etc/shadow`、各种服务凭据；
 *   - `/var/run`：**docker socket 就在这里**。挂进去等于把宿主 root 交出去；
 *   - `/proc` `/sys` `/dev`：内核接口，容器逃逸的经典入口。
 */
export const POSIX_FORBIDDEN_MOUNT_PREFIXES: readonly string[] = [
  '/home',
  '/root',
  '/etc',
  '/var/run',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
]

/** 不能**作为任务目录本身**的路径（POSIX 那一份）。比禁挂前缀短：`/home/me/project` 是正常的。 */
export const POSIX_DANGEROUS_TASK_DIRS: readonly string[] = [
  '/',
  '/home',
  '/root',
  '/etc',
  '/usr',
  '/var',
  '/var/run',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
]

/** POSIX 上的 docker socket。 */
export const POSIX_DOCKER_SOCKET_PATH = '/var/run/docker.sock'

/**
 * Windows 上「任何盘的根目录下都不许碰」的那几段名字。
 *
 * 写名字而不是写 `C:\Windows` 这样的完整路径，是因为**系统盘不一定是 C:**：
 * 写死盘符的话，装在 D: 上的机器上这套规则一条都命中不了，而且它不报错，
 * 只是不生效。所以下面匹配的是 `[盘符]:\<名字>`（大小写不敏感）这个形状。
 */
export const WINDOWS_RESERVED_ROOT_DIRS: readonly string[] = [
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'Users',
  'Boot',
  'Recovery',
  'PerfLogs',
  '$Recycle.Bin',
  'System Volume Information',
]

/**
 * Windows 上给人和给 doctor 看的那份禁挂前缀。
 *
 * 它**只是展示用**：真正判定走 `matchForbiddenMountSource()`（见那里为什么）。
 * 列出来是因为「这台机器上到底禁了什么」需要一个能打印出来的答案，而 Windows 上
 * 这个答案的形状是「任意盘符 + 这几个名字」——写死 `C:` 反而是错的（见上一条）。
 */
export const WINDOWS_FORBIDDEN_MOUNT_PREFIXES: readonly string[] = [
  '<盘符>:\\',
  ...WINDOWS_RESERVED_ROOT_DIRS.map((name) => `<盘符>:\\${name}`),
  '\\\\<主机>\\<共享>（UNC）',
  '\\\\?\\ / \\\\.\\（Windows 设备路径）',
  '\\\\.\\pipe\\docker_engine',
]

/** Windows 上的 docker 端点：一个命名管道，不是文件。 */
export const WINDOWS_DOCKER_PIPE_PATH = '\\\\.\\pipe\\docker_engine'

/**
 * 宿主路径规则：一个平台一份，问的全是「这条路径能不能当挂载源」这一类问题。
 *
 * `path` 是**字符串语义**（分隔符、绝对路径的写法、大小写），不是「照它去读写磁盘」。
 * 真实文件系统调用永远由跑测试的这台机器决定，两者只在「注入的平台 == 这台机器」
 * 时一致——测试要模拟别的平台时只用纯字符串的那些判定，见 `session/mount-policy.test.ts`。
 */
export interface HostPathRules {
  readonly platform: HostPlatform
  /** 这个平台的路径字符串语义。 */
  // `typeof path.posix` 而不是某个具名类型：`@types/node` 在两代之间改过这个名字
  // （`path.PlatformPath` 与 `path as posix` 是同一件事的两种写法），而这里要的
  // 恰恰就是「跟 path.posix 同一套方法」。
  readonly path: typeof path.posix
  /** 文件系统是否大小写不敏感。Windows 默认是，macOS 默认也是（APFS 默认卷）。 */
  readonly caseInsensitive: boolean
  /** 禁挂前缀（展示用；判定用 `matchForbiddenMountSource`）。 */
  readonly forbiddenMountPrefixes: readonly string[]
  /** 不能当任务目录/实例根的路径（展示用；判定用 `isDangerousRoot`）。 */
  readonly dangerousTaskDirs: readonly string[]
  /** docker 的可执行端点。POSIX 上是 socket 文件，Windows 上是命名管道。 */
  readonly dockerSocketPath: string
  /**
   * 这条宿主路径落在哪条禁挂规则里；没命中就是 `null`。
   *
   * 返回的是**规则的名字**（人话），不是布尔：报错要说清「你挂到系统盘根去了」
   * 或者「这是个 UNC 路径」，而不是一句笼统的「禁止路径」——后者用户没法照着改。
   */
  matchForbiddenMountSource(source: string): string | null
  /** 这条路径本身就是一个「不许当根用」的位置（文件系统根、系统目录……）。 */
  isDangerousRoot(candidate: string): boolean
  /**
   * 这条路径能不能当**可写挂载源的根**（实例根就是它）。不能就是理由，可以就是 `null`。
   *
   * 为什么它不能由 `matchForbiddenMountSource()` 直接顶替：**默认实例根就落在主目录
   * 下面**（`~/.abx/instances`），而「主目录不许挂」正是禁挂名单里的一条。所以这一问
   * 必须带上 `homeDir`，把**罩住 home 的那条规则让开**——让开之后剩下的照旧一条不放
   * （`~/.ssh/instances` 这类由 `FORBIDDEN_INSTANCE_ROOT_SUBDIRS` 另外拦，见 mount-policy）。
   *
   * 这是唯一一处「让路」，所以它单独一个方法，而不是散在调用方。
   */
  instanceRootViolation(candidate: string, homeDir: string): string | null
}

function posixMatchForbiddenMountSource(source: string): string | null {
  if (source === POSIX_DOCKER_SOCKET_PATH) return POSIX_DOCKER_SOCKET_PATH
  return (
    POSIX_FORBIDDEN_MOUNT_PREFIXES.find(
      (prefix) => source === prefix || source.startsWith(`${prefix}${path.posix.sep}`),
    ) ?? null
  )
}

/**
 * 这条路径是不是「主目录或它的上级」。
 *
 * 让路的判据不是「等于 home」，而是「**罩住** home」：`/home` 与 `/home/dev` 都要让，
 * 因为默认实例根 `/home/dev/.abx/instances` 落在两者下面。
 */
function posixCoversHome(candidate: string, homeDir: string): boolean {
  return homeDir === candidate || homeDir.startsWith(`${candidate}${path.posix.sep}`)
}

function posixInstanceRootViolation(candidate: string, homeDir: string): string | null {
  const prefix = POSIX_FORBIDDEN_MOUNT_PREFIXES.find(
    (rule) => !posixCoversHome(rule, homeDir) && (candidate === rule || candidate.startsWith(`${rule}${path.posix.sep}`)),
  )
  return prefix === undefined ? null : `它落在禁挂前缀 ${prefix} 里`
}

/**
 * Windows 路径归一化：统一成反斜杠、去掉末尾分隔符、转小写。
 *
 * 大小写这一步不能省：Windows 的文件系统大小写不敏感，`c:\windows` 与 `C:\Windows`
 * 是同一个目录。按大小写敏感去比，等于留了一个「换个大小写就绕过去」的口子。
 * 归一化之后的盘根统一写成 `c:\`（`c:` 与 `c:\` 在判定上是同一个位置）。
 */
function normalizeWindowsPath(source: string): string {
  const slashed = source.replaceAll('/', '\\').toLowerCase()
  const trimmed = slashed.replace(/\\+$/, '')
  return /^[a-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
}

/**
 * 一次命中的两副面孔：给人看的名字，和让路判定要用的前缀。
 *
 * 分开是因为**这两个东西回答的不是同一个问题**。报错要的是「C:\Windows」这样能照着
 * 改的名字；而「这条规则罩不罩住 home」要的是一段能比较的前缀。UNC 与设备路径压根
 * 没有前缀这回事（它们是另一个命名空间），所以那里是 `null`——也就无路可让。
 */
interface WindowsMatch {
  readonly label: string
  /** 归一形（小写、反斜杠）。UNC/设备路径是 `null`。 */
  readonly prefix: string | null
}

/**
 * Windows 上的禁挂判定。
 *
 * 四类按这个顺序判，因为它们**形状完全不同**，硬凑成一张前缀名单只会互相遮蔽：
 *   1. docker 命名管道——单独点名，它是最容易被顺手挂进去、后果也最严重的一个；
 *   2. 设备路径与 UNC（`\\?\`、`\\.\`、`\\主机\共享`）——一律拒，不试图解释里面是什么；
 *   3. `[盘符]:\<名字>` 形状的保留目录；
 *   4. 盘根本身。
 *
 * **盘符不写死。** Windows 装在 D: 上也常见，而写死 `C:\Windows` 的名单在那种机器上
 * 一条都命中不了——它不报错，只是整条闸门不生效。所以这里判的是形状。
 */
function windowsMatch(source: string): WindowsMatch | null {
  const normalized = normalizeWindowsPath(source)

  if (normalized === WINDOWS_DOCKER_PIPE_PATH.toLowerCase()) {
    return { label: WINDOWS_DOCKER_PIPE_PATH, prefix: normalized }
  }

  if (normalized.startsWith('\\\\')) {
    const device = normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')
    return { label: device ? 'Windows 设备路径' : 'UNC 路径', prefix: null }
  }

  const drive = /^([a-z]):\\(.*)$/.exec(normalized)
  if (drive === null) return null

  const letter = drive[1] ?? ''
  const rest = drive[2] ?? ''
  // 盘根 `C:\` 本身：挂进去等于把整块盘交出去。
  if (rest === '') return { label: `盘根 ${letter.toUpperCase()}:\\`, prefix: `${letter}:\\` }

  const [first] = rest.split('\\')
  // 名字按名单里的规范写法回填（归一形是小写的），这样报错里出现的是用户能在
  // 资源管理器里照着找的那一串，而不是 `C:\program files`。
  // 名单里的名字大小写是**展示用**的规范写法；判定一律先归小写，所以
  // `C:\WINDOWS` 与 `c:\windows` 命中同一条。
  const reserved = WINDOWS_RESERVED_ROOT_DIRS.find((name) => name.toLowerCase() === first)
  if (reserved !== undefined) {
    return { label: `${letter.toUpperCase()}:\\${reserved}`, prefix: `${letter}:\\${first}` }
  }
  return null
}

function windowsMatchForbiddenMountSource(source: string): string | null {
  return windowsMatch(source)?.label ?? null
}

function windowsInstanceRootViolation(candidate: string, homeDir: string): string | null {
  const matched = windowsMatch(candidate)
  if (matched === null) return null
  // 默认实例根 `C:\Users\me\.abx\instances` 正好落在 `C:\Users` 这条规则里，所以
  // 罩住 home 的规则要让路——同样是按形状算，不按某个写死的盘符。
  const home = normalizeWindowsPath(homeDir)
  if (matched.prefix !== null && (home === matched.prefix || home.startsWith(`${matched.prefix}\\`))) return null
  return `它落在禁挂规则 ${matched.label} 里`
}

function windowsIsDangerousRoot(candidate: string): boolean {
  return windowsMatch(candidate) !== null
}

const RULES: Readonly<Record<HostPlatform, HostPathRules>> = {
  linux: {
    platform: 'linux',
    path: path.posix,
    caseInsensitive: false,
    forbiddenMountPrefixes: POSIX_FORBIDDEN_MOUNT_PREFIXES,
    dangerousTaskDirs: POSIX_DANGEROUS_TASK_DIRS,
    dockerSocketPath: POSIX_DOCKER_SOCKET_PATH,
    matchForbiddenMountSource: posixMatchForbiddenMountSource,
    isDangerousRoot: (candidate) => POSIX_DANGEROUS_TASK_DIRS.includes(candidate),
    instanceRootViolation: posixInstanceRootViolation,
  },
  darwin: {
    platform: 'darwin',
    path: path.posix,
    // macOS 的默认文件系统（APFS/HFS+ 的默认卷）大小写不敏感。
    // 注意：这只是**记录事实**，判定仍然按大小写敏感走——macOS 上的家目录叫
    // `/Users`，现有那套 POSIX 名单一直是这么判的，改它会动到已经在跑的行为。
    caseInsensitive: true,
    forbiddenMountPrefixes: POSIX_FORBIDDEN_MOUNT_PREFIXES,
    dangerousTaskDirs: POSIX_DANGEROUS_TASK_DIRS,
    dockerSocketPath: POSIX_DOCKER_SOCKET_PATH,
    matchForbiddenMountSource: posixMatchForbiddenMountSource,
    isDangerousRoot: (candidate) => POSIX_DANGEROUS_TASK_DIRS.includes(candidate),
    instanceRootViolation: posixInstanceRootViolation,
  },
  win32: {
    platform: 'win32',
    path: path.win32,
    caseInsensitive: true,
    forbiddenMountPrefixes: WINDOWS_FORBIDDEN_MOUNT_PREFIXES,
    dangerousTaskDirs: WINDOWS_FORBIDDEN_MOUNT_PREFIXES,
    dockerSocketPath: WINDOWS_DOCKER_PIPE_PATH,
    matchForbiddenMountSource: windowsMatchForbiddenMountSource,
    isDangerousRoot: windowsIsDangerousRoot,
    instanceRootViolation: windowsInstanceRootViolation,
  },
}

/**
 * 这个平台的路径规则。**认不出就抛**，不给默认值。
 *
 * 参数写成 `HostPlatform`：类型上挡住手滑，但运行期还是自己查一遍——这个值来自
 * `process.platform`，而它的类型里有 `freebsd`、`aix` 这些我们没写规则的系统。
 * 那种情况下正确的行为是**什么都不放行**，所以这里抛而不是退回某一份规则。
 */
export function hostPathRulesFor(platform: HostPlatform): HostPathRules {
  const rules = RULES[platform]
  if (rules === undefined) {
    throw new Error(
      `不认识的宿主平台 ${JSON.stringify(platform)}：这套隔离只在 ${HOST_PLATFORMS.join(' / ')} 上有规则，` +
        `认不出来就一条都不放行。`,
    )
  }
  return rules
}
