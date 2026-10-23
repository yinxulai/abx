/**
 * 测试用的宿主平台夹具。
 *
 * 为什么要有这个文件：这套东西里几乎每一条路径断言都跟**宿主是什么系统**有关，
 * 而开发机只有一台。写死 `/home/dev/...` 的用例在 Linux 上是绿的、在 Windows 上
 * 判的是另一套规则（那些路径在 win32 眼里是「当前盘根下」），于是同一条断言
 * 在两边得出不同结论——**而两边都"跑过了"**。所以夹具必须按平台造。
 *
 * 两条用法，别混：
 *
 *   1. **要碰文件系统的用例**（mkdtemp、realpath、软链、权限位）只能用
 *      `RUNNING_PLATFORM` / `RUNNING_RULES`：真实系统调用永远由跑测试这台机器
 *      决定，模拟不了。这些用例验的是「这台机器上确实是这样」。
 *   2. **纯字符串的判定用例**（禁挂前缀、盘符、UNC、前缀边界）用
 *      `hostVocabulary(platform)` 对三个平台各跑一遍。这些用例一个系统调用都没有，
 *      所以在 Linux 上就能把 win32 那套规则完整验一遍——那是唯一验得了的办法。
 *
 * 这个文件本身不进覆盖率（`vitest.config.ts` 的 `exclude` 里有 test-support 那一条）：
 * 它是夹具，不是产品代码。
 */

import { hostPathRulesFor, requireHostPlatform } from './host-platform'
import type { HostPathRules, HostPlatform } from './host-platform'

/**
 * 跑测试这台机器的宿主平台。
 *
 * **这是测试里唯一允许读 `process.platform` 的地方。** 别处再读一次，就等于把一个
 * 「只在真机上才走得到」的分支又写回来了。用 `requireHostPlatform` 而不是直接转类型：
 * 在一台我们没有规则的系统上跑测试，应该**当场说清楚**，而不是让下面每一条断言
 * 各失败一次、每次给一个看不懂的理由。
 */
export const RUNNING_PLATFORM: HostPlatform = requireHostPlatform(process.platform)

/** 跑测试这台机器的宿主路径规则。碰文件系统的用例用它。 */
export const RUNNING_RULES: HostPathRules = hostPathRulesFor(RUNNING_PLATFORM)

/**
 * 一个平台的路径词汇表。
 *
 * 造夹具时用它，用例里就不出现 `/home/dev` 或 `C:\Users\dev` 这种写死的形状。
 * 每个名字都挑的是那个平台上**真实存在的那种位置**：
 *
 *   - `home` —— 宿主主目录，POSIX 在 `/home/dev`，Windows 在 `C:\Users\dev`；
 *   - `taskDir` —— home 下面的一个项目目录，也就是最常见的任务目录；
 *   - `outsideDir` —— 一个正常但不在 home 下面的目录，用来造「任务目录之外的挂载源」；
 *   - `systemDir` —— 一处禁挂的系统目录，POSIX 是 `/etc`，Windows 是 `C:\Windows`；
 *   - `fsRoot` —— 文件系统的根，两种平台写法不一样（`/` 与 `C:\`）；
 *   - `elsewhere` —— 一定能过闸的一个普通目录，用来当「合法的第二个挂载点」。
 *
 * 这些路径**只是字符串**，不保证在跑测试的机器上存在。要真去读写的用例请用
 * `RUNNING_*` 加 `mkdtemp`。
 */
export interface HostVocabulary {
  readonly platform: HostPlatform
  readonly rules: HostPathRules
  /** 这个平台的路径拼接。舱内路径**不要**用它——那些永远是 POSIX，见 `session/cell-path.ts`。 */
  readonly join: (...parts: string[]) => string
  readonly home: string
  readonly taskDir: string
  readonly outsideDir: string
  readonly systemDir: string
  readonly fsRoot: string
  /** home 下面的一处普通子目录（不是任务目录）。多段就多传几个参数。 */
  underHome(...segments: string[]): string
}

const POSIX_VOCABULARY: HostVocabulary = {
  platform: 'linux',
  rules: hostPathRulesFor('linux'),
  join: (...parts) => hostPathRulesFor('linux').path.join(...parts),
  home: '/home/dev',
  taskDir: '/home/dev/projects/thing',
  outsideDir: '/srv/data',
  systemDir: '/etc',
  fsRoot: '/',
  underHome: (...segments) => hostPathRulesFor('linux').path.join('/home/dev', ...segments),
}

const WINDOWS_VOCABULARY: HostVocabulary = {
  platform: 'win32',
  rules: hostPathRulesFor('win32'),
  join: (...parts) => hostPathRulesFor('win32').path.join(...parts),
  home: 'C:\\Users\\dev',
  taskDir: 'C:\\Users\\dev\\projects\\thing',
  // 刻意**换一个盘符**：任务目录之外的正常目录在 Windows 上常常真的在别的盘上，
  // 而写死 `C:` 的规则在那种机器上一条都不生效——用 D: 造夹具能把这件事一起钉住。
  outsideDir: 'D:\\srv\\data',
  systemDir: 'C:\\Windows',
  fsRoot: 'C:\\',
  underHome: (...segments) => hostPathRulesFor('win32').path.join('C:\\Users\\dev', ...segments),
}

/**
 * 这个平台的词汇表。darwin 与 linux 共用 POSIX 那一份——两边的路径规则本来就是
 * 同一套（见 `host-platform.ts`），不同的只是 `caseInsensitive` 这个记录事实的字段。
 */
export function hostVocabulary(platform: HostPlatform): HostVocabulary {
  return platform === 'win32' ? WINDOWS_VOCABULARY : POSIX_VOCABULARY
}

/** 跑测试这台机器的词汇表。碰文件系统的用例用它。 */
export const RUNNING_VOCABULARY: HostVocabulary = hostVocabulary(RUNNING_PLATFORM)

/** 三个平台各来一份，给纯字符串的判定用例循环用。 */
export const ALL_VOCABULARIES: readonly HostVocabulary[] = [
  hostVocabulary('darwin'),
  hostVocabulary('linux'),
  hostVocabulary('win32'),
]
