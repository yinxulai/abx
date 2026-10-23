/**
 * 审计流水：一行一个 JSON 对象，追加写。
 *
 * 两条硬约束：
 *
 *   1. **Authorization 的值永远不进去。** 做法不是「记得别写」，而是让记录里根本
 *      没有这个字段——`toAuditLine` 逐字段白名单取值，调用方就算往对象上挂了
 *      `authorization`，也序列化不出来。凭据注入成功与否只记一个布尔值。
 *   2. **路径不能污染文件。** 请求路径是外部输入。如果原样写进 JSONL，一个
 *      `GET /a%0A{"decision":"allowed"}` 就能在审计文件里凭空造出一行看起来完全
 *      正常的记录。所以写入前把控制字符换成可打印形式，并截断到合理长度。
 *
 * 顺带一提，字段名跟需求里给的那八个对齐，多出来的四个（`credentialInjected` /
 * `face` / `sourceAddress` / `decision` 的细分取值）都是排查问题时真正会去看的东西。
 */

import { appendFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'

export type AuditDecision =
  /** 放行并且转发完成。 */
  | 'allowed'
  /** 目标域名不在白名单。 */
  | 'denied-egress'
  /** 来源地址不在舱面允许的网段里。 */
  | 'denied-cell-source'
  /** 舱令牌不对。 */
  | 'denied-cell-token'
  /** 令牌有效，但请求头自称的舱 id 与令牌绑定的不一致。 */
  | 'denied-cell-identity'
  /** 既不是 `/u/<id>/...`，也没带目标头。 */
  | 'denied-route'
  /** `/u/<id>/...` 里的 id 在配置里不存在。 */
  | 'denied-unknown-upstream'
  /** 上游配了却没拿到密钥。宁可拒绝，也不发一个匿名请求出去。 */
  | 'credential-missing'
  /** 连不上上游、上游提前断开。 */
  | 'upstream-error'
  /** 超时。 */
  | 'upstream-timeout'

export type BrokerFace = 'host' | 'cell'

export interface AuditRecord {
  /** ISO 8601，带毫秒。 */
  readonly ts: string
  readonly cellId: string
  /**
   * 连接的对端地址（IPv4-mapped IPv6 已归一化），拿不到就是 `null`。
   *
   * 记它是因为**拒绝才需要归因**：`denied-cell-source` 只说「不在网段里」，
   * 不说「是谁在打」。审计是事后唯一能回答这个问题的东西，而请求头是请求方
   * 自己能写的，只有这个地址不是。
   */
  readonly sourceAddress: string | null
  readonly method: string
  /** 去掉舱令牌前缀之后的路径（带查询串）。 */
  readonly path: string
  readonly upstreamId: string | null
  readonly targetHost: string | null
  readonly decision: AuditDecision
  readonly status: number
  readonly durationMs: number
  /** 只记「注入了没有」，不记注入的是什么。 */
  readonly credentialInjected: boolean
  readonly face: BrokerFace
}

/** 路径字段的长度上限。够看清是哪个接口，又不至于让一行日志有几十 KB。 */
const MAX_PATH_LENGTH = 2048
/** 其他自由文本字段（cellId / host）的上限。 */
const MAX_FIELD_LENGTH = 256

/**
 * 把外部输入压成一行 JSON 里安全的一段。
 *
 * 换行、回车、制表符统一写成转义形式：JSON 本身能正确转义它们，所以这一步防的不是
 * JSON 解析，而是**读日志的人**——`less`、`grep`、以及那些按行切分的日志采集器
 * 都按物理行工作，一个真实的换行就是一行伪造的记录。
 */
export function sanitizeField(value: string, maxLength: number = MAX_FIELD_LENGTH): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')

  // 其余 C0 控制字符也一并转义，它们同样能让终端显示错乱。
  const printable = escaped.replaceAll(/[\u0000-\u001f\u007f]/g, (char) => {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })

  if (printable.length <= maxLength) return printable
  // 截断时说明被截了：否则读到一条没有结尾的路径，会以为是程序写坏了。
  return `${printable.slice(0, maxLength)}…[truncated ${printable.length - maxLength}]`
}

/**
 * 记录 → 一行文本。
 *
 * **逐字段取值，不做展开。** 这是「审计里不会有密钥」这条保证的落点：
 * 记录对象是从调用方传进来的，白名单之外的东西一律出不去。
 */
export function toAuditLine(record: AuditRecord): string {
  const payload = {
    ts: record.ts,
    cellId: sanitizeField(record.cellId),
    sourceAddress: record.sourceAddress === null ? null : sanitizeField(record.sourceAddress),
    method: sanitizeField(record.method, 16),
    path: sanitizeField(record.path, MAX_PATH_LENGTH),
    upstreamId: record.upstreamId === null ? null : sanitizeField(record.upstreamId),
    targetHost: record.targetHost === null ? null : sanitizeField(record.targetHost),
    decision: record.decision,
    status: record.status,
    durationMs: Math.max(0, Math.round(record.durationMs)),
    credentialInjected: record.credentialInjected,
    face: record.face,
  }
  return JSON.stringify(payload)
}

export interface AuditSink {
  /** 追加一条。返回的 Promise 在真正落盘之后 resolve。 */
  write(record: AuditRecord): Promise<void>
  close(): Promise<void>
  /** 人类可读的位置描述，启动时打印用。 */
  readonly describe: string
}

/**
 * 写文件的 sink。
 *
 * 串行化：`appendFile` 并发调用在同一个 fd 上不保证整行原子，两条记录交错就会
 * 写出一行坏 JSON。这里用一条 Promise 链把写入排成一队。
 */
export function createFileAuditSink(filePath: string): AuditSink {
  let queue: Promise<void> = Promise.resolve()
  let failure: Error | null = null

  const ensureFile = async (): Promise<void> => {
    const directory = path.dirname(path.resolve(filePath))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // 先建成 0600 再写。审计流水里是「谁在什么时候访问了什么」，
    // 同机器上的其他用户没有理由读得到。
    const handle = await open(filePath, 'a', 0o600)
    await handle.close()
  }

  const ready = ensureFile()

  return {
    describe: path.resolve(filePath),
    write(record: AuditRecord): Promise<void> {
      const line = `${toAuditLine(record)}\n`
      queue = queue.then(async () => {
        try {
          await ready
          await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
        } catch (error) {
          // 审计写失败不阻断请求：这时候响应已经发出去了，唯一能做的是把这件事
          // 弄得很响。生产化时应该改成「写不进去就不放行」，这一点记在
          // docs/PHASE1-REPORT.md 的未验证项里。
          failure = error instanceof Error ? error : new Error(String(error))
          process.stderr.write(`[abx] 审计写入失败：${failure.message}\n`)
          process.stderr.write(`[abx] 未能落盘的记录：${line}`)
        }
      })
      return queue
    },
    async close(): Promise<void> {
      await queue
      if (failure !== null) throw failure
    },
  }
}

export interface MemoryAuditSink extends AuditSink {
  readonly records: AuditRecord[]
  readonly lines: string[]
}

/** 测试用的 sink。也是「审计不泄漏密钥」这条用例的取证对象。 */
export function createMemoryAuditSink(): MemoryAuditSink {
  const records: AuditRecord[] = []
  const lines: string[] = []
  return {
    describe: '<memory>',
    records,
    lines,
    write(record: AuditRecord): Promise<void> {
      records.push(record)
      lines.push(toAuditLine(record))
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  }
}
