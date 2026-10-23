/**
 * 传递窗的 MCP 面：JSON-RPC 2.0 的最小实现。
 *
 * **为什么不引 MCP SDK**：这一层要的东西少得可怜——三个方法、两个工具、没有资源、
 * 没有提示词、没有采样、没有通知订阅。为此拉进来一个会跟着协议版本漂的依赖，
 * 换来的是一棵依赖树加上「它内部到底做了什么」这个新的未知数；而这段代码总共不到
 * 两百行，全部可以读一遍。将来真的需要流式采样、资源订阅那些东西时再引，
 * 那时的理由会是具体的。
 *
 * 收的是**一条消息**（已经解析好的 JSON），吐的是**一条回复**（`null` = 不用回）。
 * 传输（stdio / HTTP）不在这里：这一层只认消息，于是它可以用最直白的方式测。
 *
 * 三个方法：
 *
 *   - `initialize`：握手。回我们的协议版本、能力、以及一小段 `instructions`——
 *     那段话是 agent 学会「做好的东西可以递出去」的唯一入口，所以它值得写清楚。
 *   - `tools/list`：两个工具，`publish` 与 `open`。**没有第三个，永远不会有。**
 *   - `tools/call`：干活。
 *
 * 工具**失败**与协议**错误**是两回事，这里分得很清：
 *
 *   - 工具失败（来源不合法、超限、名字不对）→ `result.isError = true`，
 *     理由放进 `content` 的文本里。这样舱内那个 agent 能看见「为什么不行」，
 *     也才有机会换个做法；回一个 JSON-RPC 错误的话，多数客户端只会说「工具报错了」。
 *   - 协议错误（不是 JSON-RPC、没有 method、参数不是对象）→ JSON-RPC 的 `error`。
 *     那种情况下连「谁在问什么」都不成立，没法当成工具结果。
 */

import {
  MAX_DELIVERABLE_BYTES,
  TRANSOM_SERVER_NAME,
  TRANSOM_SERVER_VERSION,
  TRANSOM_TOOL_NAMES,
  formatBytes,
} from '@abx/contracts'
import type { TransomService, TransomSession, TransomToolResult } from './service'

/**
 * 我们实现的协议版本。MCP 的日期版本号是**协商**的：客户端说它的版本，
 * 我们认识的就在回复里确认它，不认识的就把我们自己的报回去（由客户端决定要不要继续）。
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** 认识的那几个版本（从新到旧）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']

/** JSON-RPC 2.0 的几个标准错误码。只用到这三个。 */
export const JSON_RPC_ERRORS = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/**
 * 两个工具的形状。
 *
 * 描述是写给**模型**看的：它决定这个东西会不会被用对。所以说清「什么时候用」、
 * 「path 是哪一侧的路径」、以及「打开了就是宿主上真的打开了」——最后这条是产品
 * 行为，模型不知道的话会以为这只是个「标记一下」。
 */
export function transomToolDefinitions(): readonly McpToolDefinition[] {
  return [
    {
      name: 'publish',
      description:
        '把你在舱内做出来的东西递给宿主并打开它。适合：报告、图表、图片、PDF、导出的数据表。' +
        '传舱内的绝对路径（例如 /workspace/report.pdf），文件会被复制到宿主的交付窗口，' +
        '能安全打开的（图片、PDF、纯文本、CSV 等）会被自动打开；其他类型只在文件夹里显示，不会被执行。' +
        `${formatBytes(MAX_DELIVERABLE_BYTES)} 以上的文件递不了，那种东西放在工作目录里` +
        '让宿主自己去看更合适。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要递出去的文件的**舱内绝对路径**，必须在这次会话的工作目录或状态目录里。',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'open',
      description:
        '打开一份**已经用 publish 递出去**的文件（用户问「刚才那张图呢」时用它）。' +
        '只收文件名，不收路径；只能打开这次会话交付格里的东西。' +
        '与 publish 同一套规则：白名单之外的类型只在文件夹里显示，不会被打开。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '交付格里的文件名，例如 report.pdf（不带路径）。' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ]
}

/**
 * 握手时给 agent 的那段话。
 *
 * 它是这个功能**被发现**的唯一入口：工具列表里有两个名字，但「什么时候该用它们」
 * 得有人说一句。写短、写具体，别写成一份说明书。
 */
export const TRANSOM_INSTRUCTIONS =
  '这里的 publish / open 是舱内通往宿主的传递窗：你在容器里做出来的报告、图、PDF，' +
  '用 publish 递给用户，宿主会直接打开它——不然它们只会在容器里烂掉，用户永远看不到。' +
  '东西大（超过 64 MiB）、或者只是中间产物，就别递，放到工作目录里说明路径即可。'

export interface TransomMcpHandlerOptions {
  readonly service: TransomService
  /** 自报的版本。默认与产品同步（见 `TRANSOM_SERVER_VERSION`）。 */
  readonly serverVersion?: string
  /** 握手时回哪段话。默认就是 `TRANSOM_INSTRUCTIONS`。 */
  readonly instructions?: string
}

export interface TransomMcpHandler {
  /**
   * 处理一条消息。返回 `null` 表示这是一条通知，不用回。
   *
   * **会话是第二个参数，不在消息里。** 这一条是安全上的要害：`params` 是舱内那个
   * agent 能写的，让它捎带 `session` 就等于让它自报身份。会话由调用方（broker）
   * 从**舱令牌**解出来传进来，与消息体完全无关。
   */
  handle(message: unknown, session: TransomSession): Promise<unknown | null>
}

/**
 * 造一个处理器。
 *
 * 注意这里**不碰任何 I/O**，也没有「当前是谁」这种状态——那种状态一旦存在，
 * 就会出现「A 会话的请求用了 B 会话的身份」这一类最难查的错。
 */
export function createTransomMcpHandler(options: TransomMcpHandlerOptions): TransomMcpHandler {
  const tools = transomToolDefinitions()
  const serverVersion = options.serverVersion ?? TRANSOM_SERVER_VERSION
  const instructions = options.instructions ?? TRANSOM_INSTRUCTIONS

  return {
    async handle(message: unknown, session: TransomSession): Promise<unknown | null> {
      if (!isObject(message)) {
        return errorResponse(null, JSON_RPC_ERRORS.invalidRequest, '请求体必须是一个 JSON 对象（JSON-RPC 2.0）。')
      }

      const id = message.id
      const method = message.method
      // 没有 id 的是**通知**（`notifications/initialized` 就是一条）。通知按定义不用回，
      // 包括「不认识的通知」——回一条 id 为 null 的错误只会让客户端把它当成协议错误。
      const isNotification = id === undefined
      if (typeof method !== 'string') {
        return isNotification ? null : errorResponse(idOrNull(id), JSON_RPC_ERRORS.invalidRequest, 'method 必须是一个字符串。')
      }

      if (isNotification) return null

      if (method === 'initialize') {
        const params = isObject(message.params) ? message.params : {}
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
        return resultResponse(idOrNull(id), {
          // 认识的版本就确认它，不认识的报我们自己的：让客户端去决定要不要继续。
          protocolVersion: requested !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: TRANSOM_SERVER_NAME, version: serverVersion },
          instructions,
        })
      }

      if (method === 'tools/list') {
        return resultResponse(idOrNull(id), { tools })
      }

      if (method === 'tools/call') {
        // 工具结果也必须套在 JSON-RPC 的信封里（`{jsonrpc, id, result}`）。
        // 「协议错」与「工具错」在这一层分开：前者是信封上的 `error`，后者是
        // `result.isError`——两种回法都出现在这里，所以包信封这件事只能在这一处做。
        const call = await callTool(options.service, message.params, session)
        if (!call.ok) return errorResponse(idOrNull(id), call.code, call.message)
        return resultResponse(idOrNull(id), call.result)
      }

      // 严格说协议的最小集合只是上面三个方法。多出这两行是为了不把一个**心跳**
      // 变成一条报错：客户端探活时收到 -32601，会据此把连接判成坏的。
      if (method === 'ping') {
        return resultResponse(idOrNull(id), {})
      }

      return errorResponse(idOrNull(id), JSON_RPC_ERRORS.methodNotFound, `不支持的方法：${method}。`)
    },
  }
}

/**
 * 一次 `tools/call` 的结果。
 *
 * 「协议错」与「工具错」在这里就分开，调用方只负责按 `ok` 选信封还是选 `result`——
 * 于是不会出现「工具结果忘了套信封」这种错（它真的发生过，是被用例逮住的）。
 */
type ToolCallOutcome = { ok: true; result: unknown } | { ok: false; code: number; message: string }

async function callTool(service: TransomService, params: unknown, session: TransomSession): Promise<ToolCallOutcome> {
  if (!isObject(params)) {
    return { ok: false, code: JSON_RPC_ERRORS.invalidParams, message: 'tools/call 的 params 必须是一个对象。' }
  }
  const name = params.name
  if (typeof name !== 'string') {
    return { ok: false, code: JSON_RPC_ERRORS.invalidParams, message: 'tools/call 需要一个字符串 name。' }
  }
  const args = isObject(params.arguments) ? params.arguments : {}

  if (name === 'publish') {
    const cellPath = args.path
    if (typeof cellPath !== 'string') {
      return { ok: true, result: toolError('publish 需要一个字符串参数 path：要递出去的文件的舱内绝对路径。') }
    }
    return { ok: true, result: toolResult(await service.publish(session, cellPath)) }
  }

  if (name === 'open') {
    const fileName = args.name
    if (typeof fileName !== 'string') {
      return { ok: true, result: toolError('open 需要一个字符串参数 name：交付格里的文件名（不带路径）。') }
    }
    return { ok: true, result: toolResult(await service.open(session, fileName)) }
  }

  // 不认识的名字是**工具**层面的错，不是协议错：客户端拿到的工具列表就是这两个，
  // 出现别的说明它记错了，而它需要看见「有哪两个可用」。
  return {
    ok: true,
    result: toolError(`没有这个工具：${name}。这里只有 ${TRANSOM_TOOL_NAMES.join(' 和 ')}。`),
  }
}

function toolResult(outcome: TransomToolResult): unknown {
  return {
    content: [{ type: 'text', text: outcome.message }],
    isError: !outcome.ok,
  }
}

function toolError(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true }
}

function resultResponse(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function idOrNull(id: unknown): string | number | null {
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
