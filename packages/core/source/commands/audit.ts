/**
 * `abx audit [--tail]` —— 看审计流水。
 *
 * 两种输出：
 *   默认是给人看的对齐表格；
 *   `--json` 原样吐 JSONL，接给 `jq` 或者别的工具。
 *
 * 表格里**没有**授权头那一列——不是因为这里过滤掉了，而是审计记录里压根没有
 * 这个字段（见 `@abx/broker` 的 `toAuditLine`）。这一层的职责是「别把它加回来」。
 */

import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AuditRecord } from '../broker/index'
import type { CommandOptions } from './options'
import { CommandError, type CommandContext } from './runtime'

export interface AuditInput {
  readonly options: CommandOptions
  readonly context: CommandContext
  readonly log: (message: string) => void
}

export async function runAudit(input: AuditInput): Promise<number> {
  const { options, context, log } = input
  const auditPath = context.config.broker.auditPath

  if (!existsSync(auditPath)) {
    // 没有审计文件不是错误。第一次跑之前它就是不存在的，
    // 报一个红字只会让人以为装坏了。
    log(`还没有审计流水。它会在第一次有请求经过 broker 时创建于 ${auditPath}`)
    return 0
  }

  let printed = 0
  const printLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    printed += 1
    if (options.json) {
      process.stdout.write(`${trimmed}\n`)
      return
    }
    process.stdout.write(`${formatRecord(trimmed)}\n`)
  }

  if (!options.json) log(`审计流水 ${auditPath}`)

  await readLines(auditPath, printLine)

  if (!options.tail) {
    if (!options.json) log(`共 ${printed} 条。`)
    return 0
  }

  return await follow(auditPath, printLine, printed)
}

async function readLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of reader) onLine(line)
}

/**
 * 跟随文件增长。
 *
 * 用轮询而不是 `fs.watch`：审计写入是「打开-追加-关闭」，不同平台的 watch 对这个模式
 * 给出的通知差别很大（有的只在创建时通知一次，有的在删除时给个 rename）。
 * 200ms 一次的 `statSync` 便宜、跨平台行为一致，而这是一个人盯着的命令，
 * 200 毫秒的延迟根本看不出来。
 */
async function follow(filePath: string, onLine: (line: string) => void, printed: number): Promise<number> {
  let offset = statSync(filePath).size
  let count = printed

  // `watch` 只用来做「有变化就早点看」，真正的读取仍然按 offset 走，
  // 所以通知丢了也不会漏行——最多晚 200ms。
  const watcher = watch(filePath, { persistent: true })
  const wake = (): void => {
    void drain()
  }
  watcher.on('change', wake)

  const drain = async (): Promise<void> => {
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return
    }
    if (size <= offset) {
      // 文件被截断或轮转时回到开头，否则会一直读不到新内容。
      if (size < offset) offset = 0
      else return
    }

    const stream = createReadStream(filePath, { encoding: 'utf8', start: offset })
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of reader) {
      onLine(line)
      count += 1
    }
    offset = size
  }

  const interval = setInterval(() => void drain(), 200)

  return await new Promise<number>((resolve) => {
    const stop = (): void => {
      clearInterval(interval)
      watcher.close()
      process.stdout.write(`\n已停止跟随，共 ${count} 条。\n`)
      resolve(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/**
 * 一行 JSON → 一行给人看的文本。
 *
 * 解析不了就原样打出来并标注：审计文件是可追加的纯文本，写到一半被 kill 掉
 * 完全可能留下半行，这时候把原文显示出来比吞掉它有用得多。
 */
export function formatRecord(line: string): string {
  let record: Partial<AuditRecord>
  try {
    record = JSON.parse(line) as Partial<AuditRecord>
  } catch {
    return `? 无法解析的一行：${line}`;
  }

  const time = (record.ts ?? '').replace('T', ' ').replace('Z', '').slice(0, 23)
  const decision = (record.decision ?? '?').padEnd(24)
  const status = String(record.status ?? '?').padStart(3)
  const duration = `${Math.round(record.durationMs ?? 0)}ms`.padStart(7)
  const face = (record.face ?? '?').padEnd(4)
  const credential = record.credentialInjected === true ? '注入' : '  — '
  const target = record.targetHost ?? record.upstreamId ?? '-'

  return `${time}  ${decision} ${status} ${duration}  ${face} ${credential}  ${record.method ?? '?'} ${record.path ?? ''} → ${target}`
}

export function auditPathOf(context: CommandContext): string {
  return context.config.broker.auditPath
}

export function assertAuditReadable(context: CommandContext): void {
  const auditPath = context.config.broker.auditPath
  if (existsSync(auditPath) && statSync(auditPath).isDirectory()) {
    throw new CommandError(`审计路径指向一个目录，不是一个文件：${auditPath}`)
  }
}
