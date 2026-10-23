/**
 * `abx broker` —— 前台跑 broker。
 *
 * 舱令牌的来源在这里定死：环境变量优先；没有就生成一个，并**落盘到令牌文件**。
 * 落盘是为了让后面起来的 `abx open` 能拿到同一个值——两个独立进程之间没有别的
 * 传递渠道，而拿错令牌的表现是舱内一片 401，很难归因。
 */

import {
  createFileAuditSink,
  defaultCellTokenPath,
  generateCellToken,
  startBroker,
  writeCellTokenFile,
  type BrokerHandle,
} from '../broker/index'
import type { CommandOptions } from './options'
import { CommandError, allowedCellSubnetsFor, resolveBackend, resolveCellHost, type CommandContext } from './runtime'

export interface BrokerInput {
  readonly options: CommandOptions
  readonly context: CommandContext
  readonly log: (message: string) => void
}

export async function runBroker(input: BrokerInput): Promise<number> {
  const { options, context, log } = input
  const { config } = context

  // `abx broker` 不跑 agent，所以「后端」在这里只有一个作用：
  // 决定舱面绑到哪儿。local 后端（宿主上跑）→ 回环；docker → 配置里的网桥地址。
  const backend = resolveBackend(config, options.backend)
  const cellHost = resolveCellHost(config, backend, options.cellHost)

  const fromEnv = context.env[config.broker.cellTokenEnv]
  const explicit = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : null
  const tokenFilePath = options.tokenFile ?? defaultCellTokenPath(config.broker.auditPath)
  const token = explicit ?? (await persistGeneratedToken(tokenFilePath, log))

  let handle
  try {
    handle = await startBroker({
      config,
      env: context.env,
      cellToken: token,
      cellHost,
      allowedCellSubnets: allowedCellSubnetsFor(cellHost),
      auditSink: createFileAuditSink(config.broker.auditPath),
    })
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error))
  }

  if (explicit === null) {
    log(`[abx] 舱令牌已写入 ${tokenFilePath}（0600），abx open 会从这里读。`)
  }
  log('[abx] 按 Ctrl-C 退出。')

  return await waitForShutdown(handle)
}

function persistGeneratedToken(filePath: string, log: (message: string) => void): string {
  // 用 broker 包里的生成器：两边算法一致，长度和字符集不会被改歪。
  const token = generateCellToken()
  try {
    writeCellTokenFile(filePath, token)
  } catch (error) {
    log(`[abx] 警告：舱令牌写不进 ${filePath}（${error instanceof Error ? error.message : String(error)}）。`)
    log('[abx] abx open 将拿不到这个令牌，请改用环境变量传递。')
  }
  return token
}

/** 等到收到 SIGINT / SIGTERM，然后把两个监听面和审计 sink 干净地关掉。 */
async function waitForShutdown(handle: BrokerHandle): Promise<number> {
  return await new Promise<number>((resolve) => {
    let closing = false
    const shutdown = (signal: NodeJS.Signals): void => {
      if (closing) return
      closing = true
      process.stdout.write(`\n[abx] 收到 ${signal}，正在关闭…\n`)
      handle
        .close()
        .then(() => resolve(0))
        .catch((error: unknown) => {
          process.stderr.write(`[abx] 关闭时出错：${error instanceof Error ? error.message : String(error)}\n`)
          resolve(1)
        })
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}
