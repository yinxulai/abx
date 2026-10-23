/**
 * 交付物的来源：舱内那条路径，到底是宿主上的哪个文件。
 *
 * 这是传递窗**第一道**闸，也是唯一一道「这条路径是谁给的」的闸。舱内的 agent 递上来的
 * 是一个**舱内路径**（`/workspace/report.pdf`），而宿主上并没有 `/workspace` 这个目录
 * ——那是容器里的挂载点。所以宿主这边必须**通过这次会话自己建立的挂载表**把它翻回来，
 * 而不是拿着字符串去 `stat`。
 *
 * 这件事的安全含义就一句话：**能递出去的东西，只能是这次会话挂进舱的那些目录里的东西。**
 *
 * 于是三道检查缺一不可：
 *
 *   1. **落点必须对得上一个挂载根**。对不上就拒——包括 `/etc/passwd`、`/workspace/../../etc`
 *      这种写法，它们归一化之后都不在任何一个根底下。
 *   2. **realpath 之后还得在根底下**。第 1 步只看了字面路径，而舱内那个 agent 可以
 *      在工作目录里建一个软链 `leak -> /etc/passwd`，然后递 `leak`。所以真正的判据是
 *      「解析软链之后仍然在根里面」——这一条与共享区那几道闸是同一套做法
 *      （`isUnder` 就是从 `mount-policy.ts` 复用的同一个函数，不是另写一份）。
 *   3. **必须是普通文件**。目录、设备、FIFO、socket 一律拒：传出去之后没有「打开看看」
 *      这回事，而 `open` 一个目录在几种系统上会做奇怪的事。
 *
 * 过期时间那一类问题（TOCTOU）不在这里解决：检查完到复制完之间文件还可能变。
 * 复制那一侧自己带体积上限，并且是按流边读边算的，所以「检查时 1 KB、复制时 40 GB」
 * 也不会把宿主写满。
 */

import { realpathSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'
import { MAX_DELIVERABLE_BYTES, formatBytes } from '@abx/contracts'
import { isUnderCellPath } from '../session/cell-path'
import { isUnder } from '../session/mount-policy'

/**
 * 这次会话挂进舱的一个**可写根**：舱内路径 ↔ 宿主路径。
 *
 * 只登记「这次会话自己的工作区与状态目录」。共享区那几类是只读挂载，一个字节都不该
 * 经传递窗再抄一遍（而且它们指向的是宿主上任意位置，把它们算进「来源」等于把闸门
 * 开向用户主目录的任意角落）。`/tmp` 那种 tmpfs 也不登记：里面的东西会话结束就没了，
 * 递出来的是一个指向虚空的引用。
 */
export interface CellRoot {
  /** 舱内那一格，例如 `/workspace`。必须是绝对路径。 */
  readonly cellPath: string
  /** 宿主上对应的那一格，例如 `/home/you/projects/thing`。 */
  readonly hostPath: string
  /** 这是哪一类根。报错时要说清是哪一个，否则用户不知道该往哪儿放文件。 */
  readonly kind: 'workdir' | 'state'
}

export interface ResolveCellSourceOptions {
  /** 舱内递上来的路径。 */
  readonly cellPath: string
  readonly roots: readonly CellRoot[]
}

export interface CellSource {
  /** 归一化之后的舱内路径。审计里记这个。 */
  readonly cellPath: string
  /** 宿主上真实存在的那个文件（已解析软链）。 */
  readonly hostPath: string
  /** 文件名（宿主那侧的最后一段）。 */
  readonly fileName: string
  readonly size: number
  readonly kind: CellRoot['kind']
}

export type ResolveCellSourceResult =
  | { readonly ok: true; readonly source: CellSource }
  | { readonly ok: false; readonly reason: string }

/**
 * 把一条舱内路径翻成宿主上那个文件，并且判它该不该被放行。
 *
 * 失败时给的是**一句话**，因为它会原样回到舱内那个 agent 眼前（工具调用的错误文本）。
 * 「拒绝」是产品行为的一部分：说清楚为什么、以及该怎么做，agent 才有机会换一条路
 * （把文件挪进工作目录再递一次），而不是对着一个「失败」反复重试。
 */
export function resolveCellSource(options: ResolveCellSourceOptions): ResolveCellSourceResult {
  const raw = options.cellPath
  if (typeof raw !== 'string' || raw.trim() === '') {
    return reject('没有给路径：要递的东西必须是一条舱内的绝对路径，例如 /workspace/report.pdf。')
  }
  if (raw.includes('\0')) {
    return reject('路径里有空字节：这不是一条正常的路径。')
  }
  if (!raw.startsWith('/')) {
    // 相对路径的含义取决于**谁在哪儿跑**——agent 的 cwd 与宿主这边完全可能不是同一处，
    // 拿它去拼宿主路径就是在猜。舱内是 linux，只认 `/` 开头。
    return reject(`只认舱内的绝对路径，收到的是 ${JSON.stringify(raw)}。相对路径的含义取决于当前目录，传递窗不猜。`)
  }
  if (raw.split('/').includes('..')) {
    return reject(
      `路径里有 \`..\`（${JSON.stringify(raw)}）：那是在试图走出这次会话的目录。` +
        `传递窗只递会话目录里面的东西，先把文件挪进来再递。`,
    )
  }

  const cellPath = path.posix.normalize(raw)
  const root = longestMatchingRoot(cellPath, options.roots)
  if (root === null) {
    return reject(
      `这条路径不在这次会话的舱内目录里：${describeRoots(options.roots)}。` +
        `传递窗只能递出这次会话里的东西，宿主的其他位置它一个都碰不到。`,
    )
  }

  const relative = path.posix.relative(root.cellPath, cellPath)
  const literal = path.resolve(root.hostPath, relative)

  let hostPath: string
  try {
    hostPath = realpathSync(literal)
  } catch (error) {
    return reject(
      `宿主上找不到这个文件（${literal}）：${errorText(error)}。` +
        `舱内那条路径要对应到一个真实存在的文件——先在舱内确认它写出来了。`,
    )
  }

  // 真正的闸门在这儿：字面路径在根里面不算数，**解析软链之后**还在根里面才算数。
  // `ln -s /etc/passwd leak` 然后递 `leak`，前面几步全都是通过的。
  const realRoot = realpathOf(root.hostPath)
  // 分隔符是**跑这台机器**的 `path.sep`，不是某个注入的平台：这里比的两个字符串
  // （`hostPath` 与 `realRoot`）都是这台机器真实的系统调用吐出来的（`realpathSync` /
  // `path.resolve`），形状由文件系统决定，注入不进来。宿主侧的路径一律走这一套；
  // 舱内路径那一半永远走 POSIX，见下一处与 `cell-path.ts`。
  if (!isUnder(hostPath, realRoot, path.sep)) {
    return reject(
      `这个文件解析软链之后落在了会话目录之外：${hostPath} 不在 ${realRoot} 里面。` +
        `符号链接指向外面时一律拒绝——那是把宿主上的任意文件递出去的路子，而它看起来只是一条普通路径。`,
    )
  }

  let stat: Stats
  try {
    stat = statSync(hostPath)
  } catch (error) {
    return reject(`宿主上读不到这个文件（${hostPath}）：${errorText(error)}。`)
  }
  if (!stat.isFile()) {
    return reject(
      `这不是一个普通文件（${cellPath}）：${describeFileKind(stat)}。` +
        `传递窗只递单个文件；要给人看一整个目录，先把它打包成文件。`,
    )
  }

  // 早一步拒掉超限的文件：这里给得出「多大、上限多少」，而复制那一步只能给一个中断。
  if (stat.size > MAX_DELIVERABLE_BYTES) {
    return reject(
      `这个文件有 ${formatBytes(stat.size)}，超过了单次交付的上限 ${formatBytes(MAX_DELIVERABLE_BYTES)}。` +
        `它不会被截断——截断出来的 PDF 打不开、CSV 少一半，用户看到的是「agent 做的东西是坏的」。` +
        `东西大的话，它本来就在这次会话的工作目录里，宿主直接就能打开，不用走传递窗。`,
    )
  }

  return {
    ok: true,
    source: {
      cellPath,
      hostPath,
      fileName: path.basename(hostPath),
      size: stat.size,
      kind: root.kind,
    },
  }
}

/**
 * 命中哪一条根：取**最长**的那一条。
 *
 * 挂载表里可能有嵌套（状态目录可以长在工作目录里）。取最长前缀是唯一能给出确定答案的
 * 规则；随便取第一条的话，结果取决于挂载的顺序，而顺序不是这份数据的一部分。
 */
function longestMatchingRoot(cellPath: string, roots: readonly CellRoot[]): CellRoot | null {
  let best: CellRoot | null = null
  for (const root of roots) {
    const normalized = path.posix.normalize(root.cellPath)
    // 两边都是**舱内**路径（上面刚用 `path.posix.normalize` 归一过），所以走舱内
    // 那一套判定：POSIX 语义，跟宿主是 Linux 还是 Windows 无关。
    if (!isUnderCellPath(cellPath, normalized)) continue
    if (best === null || normalized.length > path.posix.normalize(best.cellPath).length) best = root
  }
  return best
}

function describeRoots(roots: readonly CellRoot[]): string {
  const labels: Record<CellRoot['kind'], string> = { workdir: '工作目录', state: '状态目录' }
  return roots.map((root) => `${labels[root.kind]} ${root.cellPath}`).join('、')
}

function describeFileKind(stat: Stats): string {
  if (stat.isDirectory()) return '那是一个目录'
  if (stat.isFIFO()) return '那是一个管道'
  if (stat.isSocket()) return '那是一个 socket'
  if (stat.isBlockDevice() || stat.isCharacterDevice()) return '那是一个设备节点'
  return '它既不是普通文件，也不是上面这些'
}

/**
 * 根那一侧的软链也要解析。
 *
 * 宿主上的任务目录本身就可能在一个软链底下（macOS 的 `/tmp` → `/private/tmp` 是最常见的
 * 那种）。不解析它的话，`isUnder` 比的是「解析过的文件」与「没解析的根」两个字符串，
 * 于是**合法文件会被判成逃逸**——一道永远在报错的闸门会被人绕过。
 */
function realpathOf(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

function errorText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOENT') return '它不存在'
  if (code === 'EACCES') return '没有权限读它'
  if (code === 'ELOOP') return '软链绕成了环'
  return error instanceof Error ? error.message : String(error)
}

function reject(reason: string): ResolveCellSourceResult {
  return { ok: false, reason }
}
