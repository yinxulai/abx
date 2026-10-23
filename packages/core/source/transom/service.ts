/**
 * 传递窗本身：把上面几块（来源闸门 / 交付格 / 打开 / 账）串成两个动作。
 *
 * 只有两个动作，而且**这是产品承诺，不是当前进度**：
 *
 *   - `publish(cellPath)`：把舱内的一个文件递给宿主。校验来源 → 复制进交付格 →
 *     按后缀判该不该打开 → 记账。舱内做出来的报告、图、PDF 从这里出去。
 *   - `open(name)`：把**已经交付过**的那一份再打开一次（用户说「刚才那个图呢」）。
 *
 * 没有第三个，而且**永远不会有 `http_fetch` / `run_shell` 这一类**：传递窗是
 * 「把做好的东西递出去」，不是「让舱内指挥宿主」。加一个能读任意 URL、能跑任意命令的
 * 工具，等于把气闸拆了装一扇门——那正是这个产品存在的理由。
 *
 * ## `open` 不是后门（这一条要想清楚）
 *
 * 只做 `publish` 的白名单是**不够**的：舱内那个 agent 完全可以先递一个 `evil.sh`
 * （被判成「只显示、不打开」），再调一次 `open` 让宿主替它跑起来。两步就绕过了整道闸，
 * 而每一步看起来都合规。
 *
 * 所以两条路走**同一份判据**：`open` 也会重新判一次后缀，白名单之外的照样只显示。
 * 于是舱内没有任何一条路径能让宿主执行一个非白名单文件——这个结论不依赖 agent 的意图。
 */

import type { Stats } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { TRANSOM_SERVER_NAME, classifyDeliverable, formatBytes } from '@abx/contracts'
import { OpenError, type Opener } from './opener'
import { deliverToOutbox, outboxDirFor, type DeliveredFile } from './outbox'
import type { TransomLedger, TransomOutcome, TransomRecord } from './ledger'
import { resolveCellSource, type CellRoot } from './source'

/** 这次会话在传递窗这一侧的身份。由 broker 从舱令牌解出来，舱内伪造不了。 */
export interface TransomSession {
  /** 这一次运行的身份（审计身份）。 */
  readonly cellId: string
  readonly agentId: string
  /**
   * 这次会话挂进舱的**可写根**：工作目录与状态目录。
   * 能递出去的东西只能在这两个里面（见 `source.ts`）。
   */
  readonly roots: readonly CellRoot[]
}

/**
 * 一次工具调用的结果。
 *
 * `message` 是给舱内那个 agent 看的那段话——它会出现在对话里，也就等于给用户看了。
 * 所以它必须**说清发生了什么、东西在哪儿**，而不是一句 `ok`。
 */
export interface TransomToolResult {
  readonly ok: boolean
  readonly message: string
}

export interface TransomServiceOptions {
  /** 交付根（`defaultOutboxRoot(...)`）。 */
  readonly outboxRoot: string
  readonly ledger: TransomLedger
  /**
   * 打开文件用的实现。`null` 表示这个平台上没有「打开」这回事——
   * 这时交付照样成功，只是没人替用户打开它，理由会写进结果与账。
   */
  readonly opener: Opener | null
  /** 注入时钟。用例要的是可重复的 ts。 */
  readonly now?: () => Date
}

export interface TransomService {
  readonly name: string
  publish(session: TransomSession, cellPath: string): Promise<TransomToolResult>
  open(session: TransomSession, name: string): Promise<TransomToolResult>
  /** 账本的位置，启动时打印用。 */
  readonly ledgerPath: string
}

export function createTransomService(options: TransomServiceOptions): TransomService {
  const now = options.now ?? (() => new Date())

  const record = (session: TransomSession, fields: Partial<TransomRecord> & Pick<TransomRecord, 'action' | 'outcome'>): TransomRecord => ({
    ts: now().toISOString(),
    cellId: session.cellId,
    agentId: session.agentId,
    cellPath: null,
    hostPath: null,
    fileName: null,
    extension: null,
    bytes: null,
    sha256: null,
    disposition: null,
    opened: false,
    openedWith: null,
    reason: null,
    ...fields,
  })

  return {
    name: TRANSOM_SERVER_NAME,
    ledgerPath: options.ledger.describe,

    async publish(session, cellPath) {
      const resolved = resolveCellSource({ cellPath, roots: session.roots })
      if (!resolved.ok) {
        // 拒绝也记账。审计要回答的问题是「它试过什么」，而不只是「它做成了什么」——
        // 一个反复试图递 /etc/passwd 的会话，是这份账里最该被看见的东西。
        await options.ledger.write(record(session, { action: 'publish', outcome: 'rejected', cellPath, reason: resolved.reason }))
        return { ok: false, message: resolved.reason }
      }

      const source = resolved.source
      const decision = classifyDeliverable(source.fileName)
      const directory = outboxDirFor(options.outboxRoot, session.cellId)
      const delivered = await deliverToOutbox({ sourcePath: source.hostPath, fileName: source.fileName, directory })

      if (!delivered.ok) {
        await options.ledger.write(
          record(session, {
            action: 'publish',
            outcome: 'rejected',
            cellPath: source.cellPath,
            fileName: source.fileName,
            extension: decision.extension,
            disposition: decision.disposition,
            reason: delivered.reason,
          }),
        )
        return { ok: false, message: delivered.reason }
      }

      const file = delivered.file
      const action = await act(options.opener, decision.disposition, file.hostPath)
      const outcome: TransomOutcome = action.opened ? 'opened' : action.attempted ? 'revealed' : 'delivered'

      try {
        await options.ledger.write(
          record(session, {
            action: 'publish',
            outcome,
            cellPath: source.cellPath,
            hostPath: file.hostPath,
            fileName: file.fileName,
            extension: decision.extension,
            bytes: file.bytes,
            sha256: file.sha256,
            disposition: decision.disposition,
            opened: action.opened,
            openedWith: action.openedWith,
            reason: action.opened ? null : action.reason ?? decision.reason,
          }),
        )
      } catch (error) {
        // **记不下来的交付不算数。** 把刚复制出来的那份撤掉，别在交付格里留一个
        // 没有任何账目对应的文件——那正是「审计是承诺」这句话的反面。
        await rm(file.hostPath, { force: true })
        return {
          ok: false,
          message:
            `这次交付没能记进审计（${describeError(error)}），所以它已经撤销了：` +
            `${file.hostPath} 被删掉了。审计是承诺，不是日志——记不下来就不算发生。`,
        }
      }

      return { ok: true, message: describeDelivery(file, decision.reason, action, decision.disposition) }
    },

    async open(session, name) {
      const directory = outboxDirFor(options.outboxRoot, session.cellId)
      const target = resolveDeliveredFile(directory, name)
      if (!target.ok) {
        await options.ledger.write(
          record(session, { action: 'open', outcome: 'rejected', fileName: name, reason: target.reason }),
        )
        return { ok: false, message: target.reason }
      }

      const fileName = path.basename(target.path)
      // 先确认它**真的在**。少了这一步，「打开一个不存在的文件」会被报成成功：
      // `open` / `xdg-open` 这类命令起得来（进程起来了），失败是在它们内部发生的，
      // 而我们是等不到那个结果的。
      const info = await statOrNull(target.path)
      if (info === null || !info.isFile()) {
        const names = await listDelivered(directory)
        const reason =
          names.length === 0
            ? `这次的交付格还是空的（${directory}），没有东西可以打开。先用 publish 把文件递出来。`
            : `${fileName} 不在这次的交付格里。里面有：${names.join('、')}。`
        await options.ledger.write(record(session, { action: 'open', outcome: 'rejected', fileName, reason }))
        return { ok: false, message: reason }
      }

      // 与 publish 走**同一份判据**：不然「先递 .sh、再 open 它」就是一条绕过白名单的路。
      const decision = classifyDeliverable(fileName)
      const action = await act(options.opener, decision.disposition, target.path)
      const outcome: TransomOutcome = action.opened ? 'opened' : action.attempted ? 'revealed' : 'failed'

      await options.ledger.write(
        record(session, {
          action: 'open',
          outcome,
          hostPath: target.path,
          fileName,
          extension: decision.extension,
          disposition: decision.disposition,
          opened: action.opened,
          openedWith: action.openedWith,
          reason: action.opened ? null : action.reason ?? decision.reason,
        }),
      )

      if (action.opened) {
        return { ok: true, message: `已打开 ${fileName}（${target.path}）。` }
      }
      if (action.attempted) {
        return {
          ok: true,
          message: `${fileName} 已经在文件夹里显示出来了，但没有打开：${action.reason ?? decision.reason}`,
        }
      }
      return { ok: false, message: action.reason ?? decision.reason }
    },
  }
}

interface ActResult {
  /** 真的「打开」了（不是只显示）。 */
  readonly opened: boolean
  /** 试着做过一个动作（打开或显示）。没做成就是 `false`。 */
  readonly attempted: boolean
  readonly openedWith: string | null
  readonly reason?: string
}

/**
 * 执行处置。**打开失败不是交付失败**：文件已经在交付格里了，用户自己去看就行。
 * 所以这里把错误收成一句理由，而不是往上抛。
 */
async function act(opener: Opener | null, disposition: 'open' | 'reveal', hostPath: string): Promise<ActResult> {
  if (opener === null) {
    return { opened: false, attempted: false, openedWith: null, reason: '这台机器上不知道怎么打开文件（平台不支持）。' }
  }
  try {
    if (disposition === 'open') {
      await opener.openFile(hostPath)
      return { opened: true, attempted: true, openedWith: opener.name }
    }
    await opener.revealInFolder(hostPath)
    return { opened: false, attempted: true, openedWith: opener.name }
  } catch (error) {
    return {
      opened: false,
      attempted: false,
      openedWith: null,
      reason: error instanceof OpenError ? error.message : `打开的时候出错了：${describeError(error)}`,
    }
  }
}

/**
 * `open` 只收**文件名**，不收路径。
 *
 * 这是「`open` 打不开任意宿主路径」这条要求在代码里的形状：进来的东西只能是一个
 * 落在交付格里的名字，`..` 与分隔符直接拒——不做「顺手 basename 一下」，
 * 因为那会把 `../../etc/passwd` 静默变成 `passwd`，用户以为他打开的是别的东西。
 */
function resolveDeliveredFile(directory: string, name: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, reason: '要打开哪个文件？给一个交付格里的文件名（不带路径）。' }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return {
      ok: false,
      reason: `open 只收文件名，不收路径（收到的是 ${JSON.stringify(name)}）。要打开的东西必须已经交付过，它就在这次会话的交付格里。`,
    }
  }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, reason: `open 只收文件名，${JSON.stringify(name)} 不是一个文件。` }
  }

  const target = path.join(directory, trimmed)
  // 拼完之后再看一眼：`path.join` 会把 `..` 吃掉，所以上面那几条不是形式主义，
  // 而这一条是兜底——真正的判据永远是「拼出来的路径就在交付格这一层」。
  if (path.dirname(target) !== directory) {
    return { ok: false, reason: `open 只能打开这次会话交付格里的文件，${JSON.stringify(name)} 指到了别处。` }
  }
  return { ok: true, path: target }
}

/** 交付成功之后那段话要用到的几样东西（就是 `deliverToOutbox` 给回来的那些）。 */
type DeliveredSummary = Pick<DeliveredFile, 'hostPath' | 'fileName' | 'bytes' | 'sha256' | 'renamed'>

/** 交付成功之后那段话。它会被用户看到，所以说清「东西在哪儿、有没有打开、为什么」。 */
function describeDelivery(file: DeliveredSummary, whitelistReason: string, action: ActResult, disposition: 'open' | 'reveal'): string {
  const lines = [
    `已交付：${file.fileName}（${formatBytes(file.bytes)}）`,
    `落到：${file.hostPath}${file.renamed ? '（重名，已经改名，原来那份没动）' : ''}`,
    `sha256：${file.sha256}`,
  ]
  if (action.opened) {
    lines.push(`宿主已经用默认应用打开了它（${action.openedWith}）。`)
  } else if (disposition === 'reveal') {
    lines.push(`没有自动打开：${whitelistReason}`)
    if (action.attempted) lines.push('已经在文件夹里显示出来了，要不要打开由用户决定。')
  } else {
    lines.push(`没能打开：${action.reason ?? '未知原因'}。文件已经在上面那个路径里了。`)
  }
  return lines.join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 交付格的当前内容。`open` 报「没有这个文件」时列出来，免得舱内只能靠猜。 */
async function listDelivered(directory: string, limit = 20): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target)
  } catch {
    return null
  }
}
