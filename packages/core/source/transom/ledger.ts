/**
 * 传递窗的账：每一次交付、每一次打开，各一行。
 *
 * 需求原文是「**审计是产品承诺，不是日志**」。这句话在这里有一个具体的、可执行的后果：
 *
 *   **记不下来的交付不算数。**
 *
 * 所以 `write()` 失败时**抛**（不像 broker 的审计 sink 那样咽下去），而调用方
 * （`service.ts`）在记不下来时会把刚复制出来的那份删掉、并告诉舱内「这次交付没发生」。
 * 于是「交付格里的每一个文件都有一条账」是一个**不变量**，不是一句愿望。
 * 反过来做（记不上也照常交付）会让审计在「磁盘满 / 权限错」的时候静默地少几条——
 * 而那恰好是用户最需要它的时候。
 *
 * 与 broker 审计的关系：两份流水，不合并。broker 那份记的是**网络**（哪个会话访问了
 * 哪个域名），这份记的是**东西**（哪个会话把哪份文件递给了宿主、宿主有没有打开它）。
 * 两者的字段几乎没有交集，硬塞进一张表只会让两张表都难查。共同的规矩只有一条，
 * 而且是照抄的：**逐字段白名单序列化**（见 `toTransomLine`），
 * 所以记录对象上多挂什么字段都写不出去。
 *
 * 里面**没有**舱令牌，也没有任何凭据：这份账的读者是用户自己，它要能放心地
 * 贴在工单里、发给别人看。
 */

import { appendFile, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DeliverableDisposition } from '@abx/contracts'
import { sanitizeField } from '../broker/audit'
import { defaultOutboxRoot } from './outbox'

/** 覆盖账本路径的环境变量。跟 `ABX_OUTBOX_ROOT` 一样，是给测试用的。 */
export const TRANSOM_LEDGER_ENV = 'ABX_TRANSOM_LEDGER'

/**
 * 账本默认落在 `~/.abx/transom.jsonl`——**不在交付格里面**。
 *
 * 交付格是用户要拿东西的地方，`ls` 出来的每一项都该是他能打开的文件。账本混在
 * 那一堆里，既会被误当成一份交付，也会被误删。
 */
export function defaultTransomLedgerPath(env: Readonly<Record<string, string | undefined>> = process.env, homeDir: string = homedir()): string {
  const fromEnv = env[TRANSOM_LEDGER_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(path.dirname(defaultOutboxRoot(env, homeDir)), 'transom.jsonl')
}

/** 传递窗的两个动作。与 `TRANSOM_TOOL_NAMES` 一一对应，不多不少。 */
export type TransomAction = 'publish' | 'open'

/**
 * 这一次到底怎么了。
 *
 * `delivered` 与 `opened` 是**两件事**，不能合成一个「成功」：文件递出来了但没打开
 * （白名单之外的、或者宿主上没有打开命令）是最常见的一种结果，而它恰恰是用户会问
 * 「我的东西呢」的那一种。
 */
export type TransomOutcome =
  /** 文件进了交付格。 */
  | 'delivered'
  /** 交付之后，宿主替你打开了它。 */
  | 'opened'
  /** 交付之后，只在文件夹里显示（白名单之外的都走这条）。 */
  | 'revealed'
  /** 没有交付：来源不合法、超限、重名到写不出来…… */
  | 'rejected'
  /** 已经开始做了，但中途失败（写不进去、打开命令不存在）。 */
  | 'failed'

export interface TransomRecord {
  /** ISO 8601，带毫秒。宿主时钟。 */
  readonly ts: string
  readonly cellId: string
  readonly agentId: string
  readonly action: TransomAction
  readonly outcome: TransomOutcome
  /** 舱内那条路径（`publish` 才有）。 */
  readonly cellPath: string | null
  /** 宿主上落到了哪儿。 */
  readonly hostPath: string | null
  readonly fileName: string | null
  /** 小写、不带点的后缀；没有后缀是空串，判不出来是 `null`。 */
  readonly extension: string | null
  readonly bytes: number | null
  /** 十六进制小写。用户拿它和舱内 `sha256sum` 对，就能确认是同一份东西。 */
  readonly sha256: string | null
  /** 白名单判出来的处置。**与「真的打开了没有」是两回事**，所以两个都记。 */
  readonly disposition: DeliverableDisposition | null
  readonly opened: boolean
  /** 用什么打开的（`open` / `xdg-open` / `explorer`）。没打开就是 `null`。 */
  readonly openedWith: string | null
  /** 拒绝或失败的理由，原样记下来——用户看到的也是这句话。 */
  readonly reason: string | null
}

/** 路径字段的上限。够看清是哪个文件，又不至于让一行有几万字符。 */
const MAX_PATH_LENGTH = 2048
/** 其他自由文本字段的上限。 */
const MAX_FIELD_LENGTH = 256
/** 理由可以说得长一点：它就是给用户读的那段话。 */
const MAX_REASON_LENGTH = 512

/**
 * 记录 → 一行文本。**逐字段取值，不做展开。**
 *
 * 与 broker 审计同一条理由：记录对象是调用方传进来的，白名单之外的字段一律出不去，
 * 所以「审计里不会有凭据」这件事不依赖调用方记得别写。控制字符也照样转义——
 * 文件名与路径是**外部输入**（舱内的 agent 能决定文件名），一个带换行的名字足以
 * 在 JSONL 里伪造出一行看着完全正常的记录。
 */
export function toTransomLine(record: TransomRecord): string {
  const payload = {
    ts: record.ts,
    cellId: sanitizeField(record.cellId),
    agentId: sanitizeField(record.agentId),
    action: record.action,
    outcome: record.outcome,
    cellPath: record.cellPath === null ? null : sanitizeField(record.cellPath, MAX_PATH_LENGTH),
    hostPath: record.hostPath === null ? null : sanitizeField(record.hostPath, MAX_PATH_LENGTH),
    fileName: record.fileName === null ? null : sanitizeField(record.fileName, MAX_FIELD_LENGTH),
    extension: record.extension === null ? null : sanitizeField(record.extension, 32),
    bytes: record.bytes,
    sha256: record.sha256,
    disposition: record.disposition,
    opened: record.opened,
    openedWith: record.openedWith === null ? null : sanitizeField(record.openedWith, 64),
    reason: record.reason === null ? null : sanitizeField(record.reason, MAX_REASON_LENGTH),
  }
  return JSON.stringify(payload)
}

export interface TransomLedger {
  /**
   * 追加一条。**返回的 Promise 失败意味着这次交付没有留下痕迹**——调用方必须
   * 当作交付失败来处理（见本文件开头）。
   */
  write(record: TransomRecord): Promise<void>
  close(): Promise<void>
  /** 人类可读的位置，启动时打印用。 */
  readonly describe: string
}

/**
 * 写文件的账本。
 *
 * 串行化：`appendFile` 并发调用在同一个 fd 上不保证整行原子，两条记录交错就会写出
 * 一行坏 JSON，而坏掉的那一行正好是「谁把什么递出去了」。
 */
export function createFileTransomLedger(filePath: string): TransomLedger {
  let queue: Promise<void> = Promise.resolve()
  let failure: Error | null = null

  const ready = (async () => {
    await mkdir(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 })
    // 0600：这份账里有用户的文件路径，同机器上的其他用户没有理由读得到。
    const handle = await open(filePath, 'a', 0o600)
    await handle.close()
  })()
  // 这一次「建目录 + 建文件」在**构造时**就起跑了，而唯一 await 它的地方是第一次
  // `write`。中间要是没人写过（一次会话里一个东西都没递，很正常），一个失败
  // ——目录建不出来、权限不对——就会变成**未处理的 rejection**，而 node 默认
  // 会因为它直接终止进程。挂一个空的 catch 只是把「没人接」这件事堵上：
  // 异常本身还在，第一次 write 照样抛（那才是「记不下来就不算交付」的落点）。
  void ready.catch(() => undefined)

  return {
    describe: path.resolve(filePath),
    write(record: TransomRecord): Promise<void> {
      const line = `${toTransomLine(record)}\n`
      queue = queue.then(async () => {
        if (failure !== null) {
          // 已经坏过一次就别再试了：失败会一路静默下去，而每条记录都去撞一次
          // 同一个错误只会把「磁盘满」变成一串没人看的 stack。
          throw failure
        }
        try {
          await ready
          await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
          throw failure
        }
      })
      return queue
    },
    async close(): Promise<void> {
      await queue.catch(() => undefined)
    },
  }
}

export interface MemoryTransomLedger extends TransomLedger {
  readonly records: TransomRecord[]
  readonly lines: string[]
  /** 让用例模拟「账写不进去」。 */
  failNextWith(error: Error): void
}

/** 测试用的账本。也是「账里没有令牌」这条用例的取证对象。 */
export function createMemoryTransomLedger(): MemoryTransomLedger {
  const records: TransomRecord[] = []
  const lines: string[] = []
  let pending: Error | null = null

  return {
    describe: '<memory>',
    records,
    lines,
    failNextWith(error: Error): void {
      pending = error
    },
    write(record: TransomRecord): Promise<void> {
      if (pending !== null) {
        const error = pending
        pending = null
        return Promise.reject(error)
      }
      records.push(record)
      lines.push(toTransomLine(record))
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  }
}
