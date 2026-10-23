/**
 * 传递窗的另一头：宿主上的**交付格**（outbox）。
 *
 * 目录形状：
 *
 *   ~/.abx/outbox/<cellId>/
 *   └─ report.pdf      舱内递出来的那一份，宿主上一份完整副本
 *
 * 三条不许让步的规矩，每一条都对应一种「舱内能操纵宿主文件系统」的形态：
 *
 *   1. **落点写死**。目标只能是 `<outboxRoot>/<会话 id>/<文件名>`，文件名由来源那侧
 *      的最后一段决定，调用方给不了别的路径。舱内那个 agent 影响不了目录，只能影响
 *      一个文件名（而文件名还要过一遍清洗）。
 *   2. **永不覆盖**。重名就改名（`report.pdf` → `report-2.pdf`）。覆盖会毁掉宿主上的
 *      东西，而「舱内的一次工具调用删掉了你昨天递出来的那份」是一种从现象上完全
 *      看不出原因的事故。改名用 `wx`（独占创建）落地，不是「先 exists 再写」——
 *      后者在两次调用挤在一起时会双写同一个名字。
 *   3. **边读边算上限**。文件在「检查」与「复制」之间还能长大，所以上限不能只靠
 *      来源那侧的一次 `stat`。这里逐块累加，一旦超过就**删掉半截的文件**再报错——
 *      留一个截断的副本比什么都没有更坏：它看起来是成功的。
 *
 * 复制时顺手算 sha256，它有两个用处：给用户一个核对「这一份和舱内那一份是不是同一个」
 * 的凭据，以及写进审计。哈希是**同时**算出来的，不额外读一遍文件——那既慢又给了
 * 「算完之后文件又被改了」一个新的窗口。
 *
 * 为什么是复制而不是硬链/软链：舱内那个文件随时会被 agent 改写或删掉（工作目录是
 * 可写的），而「递出来的那一份」得是**那一刻**的东西。链接指向的是一个会变的目标。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { MAX_DELIVERABLE_BYTES, formatBytes } from '@abx/contracts'

/** 覆盖交付根的环境变量。理由与 `ABX_INSTANCES_ROOT` 同：用例不能往真实的 `~/.abx` 里写。 */
export const OUTBOX_ROOT_ENV = 'ABX_OUTBOX_ROOT'

/** 交付格在 `~/.abx/` 下的目录名。 */
export const OUTBOX_DIR_NAME = 'outbox'

/**
 * 交付根：默认 `~/.abx/outbox`。
 *
 * 放在 home 下面有两个理由，和实例根一样：它跟着 home 走（macOS 上 Docker Desktop
 * 只把 home 下的路径共享给虚拟机），以及它是**用户的东西**——用户要能看到、能打开、
 * 能删掉它。放在应用数据目录里会让「做好的东西在哪儿」变成一个要查文档的问题。
 */
export function defaultOutboxRoot(env: Readonly<Record<string, string | undefined>> = process.env, homeDir: string = homedir()): string {
  const fromEnv = env[OUTBOX_ROOT_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(homeDir, '.abx', OUTBOX_DIR_NAME)
}

/** 一个会话的交付格。**只按 cellId 分**：每次运行一格，翻起来能对上审计。 */
export function outboxDirFor(outboxRoot: string, cellId: string): string {
  return path.join(outboxRoot, sanitizeSegment(cellId, 'cell'))
}

/** 清洗过的一段路径（要么原样、要么是一段安全的东西）。 */
export function sanitizeSegment(segment: string, fallback: string): string {
  const cleaned = segment
    .replaceAll(/[/\\]/g, '_')
    // 控制字符：它们不会让路径解析出错，但会让审计、日志、终端显示变得没法读。
    .replaceAll(/[\u0000-\u001f\u007f]/g, '_')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  // 前导点留着（`.env` 是个合法名字），但 `../x` 这种已经在上面被 `_` 掉了。
  if (cleaned.length > 128) {
    // 截断时把后缀留在最后：名字长得离谱时，后缀是唯一能让人一眼看出这是什么的东西。
    const extension = path.extname(cleaned)
    return `${cleaned.slice(0, 128 - extension.length)}${extension}`
  }
  return cleaned
}

export interface DeliverOptions {
  /** 来源文件（宿主上真实存在的那个，来自 `resolveCellSource`）。 */
  readonly sourcePath: string
  /** 想用的文件名。清洗之后才会用。 */
  readonly fileName: string
  /** 这个会话的交付格（`outboxDirFor(...)`）。 */
  readonly directory: string
}

export interface DeliveredFile {
  readonly hostPath: string
  /** 实际落盘用的名字。与请求的名字不同就说明改名了。 */
  readonly fileName: string
  readonly bytes: number
  /** 十六进制小写。舱内 `sha256sum` 出来的那一串应当与它逐字相同。 */
  readonly sha256: string
  /** 是否因为重名改了名。 */
  readonly renamed: boolean
}

export type DeliverResult = { readonly ok: true; readonly file: DeliveredFile } | { readonly ok: false; readonly reason: string }

/**
 * 把来源复制进交付格。
 *
 * 失败时不留残骸：半截文件会被删掉。这在 `--keep` 跑调试时会让人少一个线索，
 * 但留在那儿的东西会被下一次 `ls` 当成一份成功的交付——那比丢一个线索坏得多。
 */
export async function deliverToOutbox(options: DeliverOptions): Promise<DeliverResult> {
  const directory = options.directory
  await mkdir(directory, { recursive: true, mode: 0o700 })

  // 先看一眼大小，好在超限时给出「多大 / 上限多少」。真正的闸门是下面边读边数的那个。
  try {
    const current = await stat(options.sourcePath)
    if (current.size > MAX_DELIVERABLE_BYTES) {
      return fail(
        `${options.fileName} 有 ${formatBytes(current.size)}，超过了单次交付的上限 ${formatBytes(MAX_DELIVERABLE_BYTES)}。`,
      )
    }
  } catch (error) {
    return fail(`读不到来源文件（${options.sourcePath}）：${describeError(error)}。`)
  }

  const name = sanitizeSegment(options.fileName, 'delivered')
  let attempt = 0
  // 上限 1000 次：每一次尝试都必须是「这个名字已经被占了」，而不是随便什么错误。
  // 无限循环在这里等于「一件事把宿主卡住」，而宿主正跑着用户的会话。
  while (attempt < 1000) {
    const candidate = attempt === 0 ? name : renamedVariant(name, attempt + 1)
    const target = path.join(directory, candidate)
    const outcome = await tryCopy(options.sourcePath, target)
    if (outcome.kind === 'copied') {
      return {
        ok: true,
        file: {
          hostPath: target,
          fileName: candidate,
          bytes: outcome.bytes,
          sha256: outcome.sha256,
          renamed: attempt > 0,
        },
      }
    }
    if (outcome.kind === 'exists') {
      attempt += 1
      continue
    }
    return fail(outcome.reason)
  }
  return fail(`交付格里已经有太多同名文件了（${name}）：换一个文件名再递。`)
}

type CopyOutcome =
  | { readonly kind: 'copied'; readonly bytes: number; readonly sha256: string }
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * 复制一个文件，边读边数、边算哈希。
 *
 * `wx` 是这里的要害：文件已存在时**创建本身就失败**，不会有「先判再写」那种
 * 两个请求挤在一起就双写同一个名字的窗口。
 */
async function tryCopy(sourcePath: string, targetPath: string): Promise<CopyOutcome> {
  const hash = createHash('sha256')
  let bytes = 0
  const output = createWriteStream(targetPath, { flags: 'wx', mode: 0o600 })
  const input = createReadStream(sourcePath)
  // `open` 只在**我们**把文件建出来之后才触发；撞名时它永远不会来。
  // 上面那个 catch 靠它来决定能不能删，所以它必须在 promise 之前挂上。
  let created = false
  output.on('open', () => {
    created = true
  })

  try {
    await new Promise<void>((resolve, reject) => {
      output.on('error', reject)
      input.on('error', reject)
      input.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        bytes += buffer.byteLength
        if (bytes > MAX_DELIVERABLE_BYTES) {
          // 直接掐掉：继续读下去只是把宿主的盘写满。
          reject(new CopyTooLargeError(bytes))
          input.destroy()
          return
        }
        hash.update(buffer)
        if (!output.write(buffer)) input.pause()
      })
      output.on('drain', () => input.resume())
      input.on('end', () => output.end())
      output.on('finish', () => resolve())
    })
  } catch (error) {
    input.destroy()
    output.destroy()
    // 只在**这次真的把文件创建出来了**的情况下才删。`wx` 撞名时抛的 EEXIST
    // 意味着那个路径上躺着的是**别人的**文件（上一次的交付），删它就是一次
    // 「舱内的操作删掉了宿主上的文件」——而且没有任何东西会指向这里。
    if (created) await rm(targetPath, { force: true })
    if (isAlreadyExists(error)) return { kind: 'exists' }
    if (error instanceof CopyTooLargeError) {
      return {
        kind: 'failed',
        reason:
          `复制到一半就超过了单次交付的上限 ${formatBytes(MAX_DELIVERABLE_BYTES)}` +
          `（已经读到 ${formatBytes(error.bytes)}）：这一次交付取消了，半个文件也没有留下。` +
          `这个文件在复制期间还在长大，多半是舱内的进程还在往里写——等它写完再递。`,
      }
    }
    if (isAlreadyExists(error)) return { kind: 'exists' }
    return { kind: 'failed', reason: `写不进交付格（${targetPath}）：${describeError(error)}。` }
  }

  return { kind: 'copied', bytes, sha256: hash.digest('hex') }
}

class CopyTooLargeError extends Error {
  readonly bytes: number
  constructor(bytes: number) {
    super(`超过上限：${bytes}`)
    this.name = 'CopyTooLargeError'
    this.bytes = bytes
  }
}

/**
 * 第 n 个候选名字：`report.pdf` → `report-2.pdf`。
 *
 * 后缀保留在最后，是为了「改名之还是能用默认应用打开」：改成 `report.pdf-2`
 * 之后系统就认不出它是什么了，而用户双击一个打不开的文件，看到的不是「重名了」。
 */
function renamedVariant(fileName: string, index: number): string {
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  return `${stem === '' ? 'delivered' : stem}-${index}${extension}`
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EEXIST'
}

function describeError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOENT') return '它不存在'
  if (code === 'EACCES' || code === 'EPERM') return '权限不够'
  if (code === 'ENOSPC') return '宿主磁盘满了'
  return error instanceof Error ? error.message : String(error)
}

function fail(reason: string): DeliverResult {
  return { ok: false, reason }
}
