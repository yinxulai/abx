/**
 * 传递窗的**舱内侧**：一个 stdio 的 MCP 服务，把每条消息转发给宿主。
 *
 * 形状是这样的：
 *
 *   舱内 agent  ──stdio(MCP)──▶  abx-mcp-shim.mjs  ──HTTP──▶  宿主 broker 的 /mcp
 *
 * ## 为什么要有这一层
 *
 * 宿主那侧是 HTTP，而 agent 只会说 stdio。中间必须有个翻译。这个翻译放在舱内
 * 有一个很好的性质：**它不需要任何新能力**。它用的令牌就是舱内早就在用的那一个
 * （`ABX_CELL_TOKEN`，`buildCellEnv` 注入的），它连的地址也是舱内早就知道的
 * （`ABX_BROKER_ORIGIN`）。舱内多出来的东西只有**一个只读挂进去的脚本文件**。
 *
 * 反过来（让宿主去连舱内、或者给舱内开一个监听端口）要多开一条入站路径，
 * 而舱内本来是一个只有出站的东西。
 *
 * ## 为什么是「把源码当成字符串嵌在这里」
 *
 * 它必须**只有一个文件**：进舱的是一个只读的单文件挂载（与 agent 配置文件同一套
 * 机制），而那套机制挂的就是一个文件。所以 shim 不能有依赖、不能 `import` 仓库里的
 * 任何东西——它跑在容器里，那里除了 node 什么都没有。
 *
 * 嵌在 TypeScript 里（而不是当成一个 `.mjs` 资源文件读进来）是为了让字符串与读它的
 * 代码同生共死：`readFileSync(new URL('./x.mjs', import.meta.url))` 在打出来的产物里
 * 会指向一个不存在的位置，而那是**运行期**才发现的错——而且是「传递窗整个用不了」
 * 这种错。代价是下面那段代码里不能出现反引号与 `${`（会截断外层模板串），
 * 所以它里面只用单引号加号拼接。这条约束值得，因为替代方案是运行期才知道的失败。
 *
 * ## 它**不做**判定
 *
 * 白名单、体积上限、来源校验全部在宿主那侧（`service.ts`）。这条线是刻意的：
 * 舱内的东西一律不可信，判定写在舱内等于把闸门装在贼这一侧。shim 只做三件事——
 * 读一行、发出去、把回复写回去——这样它出错的后果也只是「消息没送到」，
 * 而不是「消息被放行了」。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { MCP_SHIM_FILE_NAME, TRANSOM_ENDPOINT_PATH } from '@abx/contracts'
import { sanitizeSegment } from './outbox'

/** 覆盖运行时根的环境变量。理由与 `ABX_OUTBOX_ROOT` 同：用例不能往真实的 `~/.abx` 里写。 */
export const RUNTIME_ROOT_ENV = 'ABX_RUNTIME_ROOT'

/** 运行时根在 `~/.abx/` 下的目录名。 */
export const RUNTIME_DIR_NAME = 'runtime'

/**
 * 运行时根：默认 `~/.abx/runtime`。
 *
 * 与交付格（`~/.abx/outbox`）并列：交付格是**给用户的**（他要打开里面的东西），
 * 这里是**给容器的**（挂进去给舱内跑）。两者混在一起会让「交付格里每个文件都是
 * 一份交付」这句话不成立——`ls` 出来的东西里会多出一个没人递过的脚本。
 */
export function defaultRuntimeRoot(env: Readonly<Record<string, string | undefined>> = process.env, homeDir: string = homedir()): string {
  const fromEnv = env[RUNTIME_ROOT_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv)
  return path.join(homeDir, '.abx', RUNTIME_DIR_NAME)
}

/**
 * 一次会话的运行时目录。
 *
 * 按 cellId 分会话，理由和交付格一样：它是个挂载源，而挂载源的路径越窄越好；
 * 顺带也让「这次会话挂进去的是哪一个文件」在出错时能一眼对上。
 */
export function runtimeDirFor(runtimeRoot: string, cellId: string): string {
  return path.join(runtimeRoot, sanitizeSegment(cellId, 'cell'))
}

export interface StagedTransomShim {
  /** 宿主上的那个文件，也就是挂载源。 */
  readonly hostPath: string
  readonly bytes: number
}

export interface StageTransomShimOptions {
  /** 落点目录（`runtimeDirFor(...)`）。 */

  readonly directory: string
}

/**
 * 把 shim 写到宿主上，等着被只读挂进舱。
 *
 * 权限 `0644`：舱内跑 agent 的不是宿主这个用户（docker 的绑定挂载不做 uid 映射），
 * 所以要让它读得到，只能是「其他用户可读」。这**不是**放松——这个文件的全部内容
 * 就是这个仓库里公开的这段脚本，它一个凭据都不含（令牌是运行期从环境变量读的）。
 */
export function stageTransomShim(options: StageTransomShimOptions): StagedTransomShim {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const hostPath = path.join(options.directory, MCP_SHIM_FILE_NAME)
  writeFileSync(hostPath, MCP_SHIM_SOURCE, { encoding: 'utf8', mode: 0o644 })
  return { hostPath, bytes: Buffer.byteLength(MCP_SHIM_SOURCE, 'utf8') }
}

/**
 * shim 的源码。
 *
 * ⚠️ 改它之前先读本文件开头那两条约束：**只用 node 内置模块**、**只用单引号加号拼接**。
 * 它会被原样写进容器，所以 `node --check` 能过只是最低要求——真正的验收在
 * `shim.test.ts` 里：那一组用例会真的起一个 HTTP 服务、真的把这个文件跑起来，
 * 用真实的消息走一遍。
 */
export const MCP_SHIM_SOURCE = `#!/usr/bin/env node
/**
 * abx 传递窗的舱内侧（自动生成，不要手改：源头在 packages/core/source/transom/shim.ts）。
 *
 * 做三件事：从 stdin 读一行 JSON、POST 给宿主的传递窗端点、把回复写到 stdout。
 * 判定（白名单、体积、来源）全在宿主那侧，这里一个都不做——舱内的东西不可信。
 *
 * 规矩：
 *   - **stdout 只有协议**。除了 JSON-RPC 消息，一个字节都不许写进去（日志走 stderr），
 *     否则客户端会读到一行不是 JSON 的东西，整个连接会被判成坏的。
 *   - **一条一条串行处理**。MCP 上先 initialize 再 tools/call，顺序有意义。
 *   - **不许崩**。任何一条消息出错都只回一条错误，进程要活着——它死了，agent
 *     就再也递不出东西了，而用户看到的只是一句「MCP 服务器断开」。
 */

import { createInterface } from 'node:readline'

const ENDPOINT = ${JSON.stringify(TRANSOM_ENDPOINT_PATH)}
const TIMEOUT_MS = 120000
const MAX_ERROR_BODY = 300

const origin = (process.env.ABX_BROKER_ORIGIN || '').replace(/\\/+$/, '')
const token = process.env.ABX_CELL_TOKEN || ''
const cellId = process.env.ABX_CELL_ID || ''

const missing = []
if (origin === '') missing.push('ABX_BROKER_ORIGIN')
if (token === '') missing.push('ABX_CELL_TOKEN')
const configurationError =
  missing.length === 0
    ? null
    : '舱里没有 ' + missing.join(' / ') + '，连不上宿主上的传递窗。这几个变量是 abx 起容器时注入的，' +
      '缺了说明这个进程不是 abx 起的。'

function note(message) {
  process.stderr.write('[abx-mcp] ' + message + '\\n')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function idOf(message) {
  if (message === null || typeof message !== 'object') return null
  const id = message.id
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}

/** 没有 id 的是通知，按 JSON-RPC 的定义不用回。 */
function isNotification(message) {
  return message !== null && typeof message === 'object' && !('id' in message)
}

function failure(message, code, text) {
  if (isNotification(message)) return null
  return { jsonrpc: '2.0', id: idOf(message), error: { code: code, message: text } }
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

async function forward(message) {
  if (configurationError !== null) return failure(message, -32603, configurationError)

  let response
  try {
    response = await fetch(origin + ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 舱令牌走头。它是这次会话的凭据，宿主那侧靠它认出「这是哪个会话」。
        'x-abx-cell': token,
        'x-abx-cell-id': cellId,
      },
      body: JSON.stringify(message),
      // 超时是必须的：宿主那侧卡住时（比如正在复制一个 64 MiB 的文件），
      // 没有超时的话这条消息会永远挂着，而 agent 那边只是在等。
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return failure(
      message,
      -32603,
      '连不上宿主上的传递窗（' + origin + ENDPOINT + '）：' + describe(error) + '。这次调用没有发生。',
    )
  }

  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    body = ''
  }

  if (!response.ok) {
    // 宿主的拒绝要**原样带给 agent**（401/403 的令牌问题、503 的 broker 没起、
    // 以及将来可能有的限流）。咽下去换成一句「失败了」，用户就永远看不到原因。
    const detail = body.trim() === '' ? '' : '：' + body.trim().slice(0, MAX_ERROR_BODY)
    return failure(message, -32603, '宿主拒绝了这次调用（HTTP ' + response.status + '）' + detail)
  }

  // 通知与「已受理」都没有回复体。
  if (body.trim() === '') return null

  try {
    return JSON.parse(body)
  } catch (error) {
    return failure(message, -32603, '宿主的回复不是 JSON（HTTP ' + response.status + '）。')
  }
}

async function handleLine(line) {
  const text = line.trim()
  if (text === '') return

  let message
  try {
    message = JSON.parse(text)
  } catch (error) {
    // 解析不出来时连 id 都没有，只能按 JSON-RPC 的解析错误回，id 写 null。
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '这不是合法的 JSON：' + describe(error) } })
    return
  }

  try {
    const reply = await forward(message)
    if (reply !== null) write(reply)
  } catch (error) {
    note('转发时出错：' + describe(error))
    const reply = failure(message, -32603, '传递窗内部出错：' + describe(error))
    if (reply !== null) write(reply)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()
lines.on('line', (line) => {
  queue = queue.then(() => handleLine(line))
})
// stdin 关了不代表活儿干完了：等在飞的那几条落地，进程自然退出。
lines.on('close', () => {
  queue = queue.then(() => {
    process.exitCode = 0
  })
})
`
