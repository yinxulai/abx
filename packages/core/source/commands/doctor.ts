/**
 * `abx doctor` —— 这台机器上能不能跑，以及跑起来会是什么样。
 *
 * 检查项分成三类，输出里也用三种记号区分：
 *   `ok`   没问题
 *   `warn` 能跑，但有个你应该知道的事实（例如白名单里有通配、docker 不可用）
 *   `fail` 跑不了，或者跑起来不是你以为的那个东西
 *
 * 有一条检查是这类工具特有、也特别容易漏的：**端口占用**。
 * broker 要绑两个端口，被占了的话失败发生在启动那一刻，而 `abx open` 的
 * 报错会指向「连不上 broker」，很难联想到是端口冲突。
 *
 * 另一条是**凭据是否就位**。这里只报「设置了没有」，永远不报值——
 * doctor 的输出经常被贴进 issue，那是最典型的泄漏场景。
 */

import { accessSync, constants, existsSync } from 'node:fs'
import path from 'node:path'
import { listWildcardPatterns, type AbxConfig } from '@abx/contracts'
import type { HostPlatform } from '../host-platform'
import { probeDocker, probeUserNamespaces, isExecutableOnPath, MOUNT_POLICY, DANGEROUS_HOST_ENV_NAMES } from '../session/index'
import { isPortOpen, resolveBackend, resolveCellHost, type CommandContext } from './runtime'
import type { CommandOptions } from './options'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: CheckStatus
  readonly detail: string
  readonly hint?: string
}

export interface DoctorInput {
  readonly options: CommandOptions
  readonly context: CommandContext
  readonly log: (message: string) => void
}

const MARKERS: Readonly<Record<CheckStatus, string>> = { ok: '✓', warn: '!', fail: '✗' }

export async function runDoctor(input: DoctorInput): Promise<number> {
  const { options, context, log } = input
  const checks = await collectChecks(context, options)

  log(`abx doctor —— 配置文件 ${context.configPath}`)
  log('')
  for (const check of checks) {
    log(`${MARKERS[check.status]} ${check.name.padEnd(22)} ${check.detail}`)
    if (check.hint !== undefined) log(`${' '.repeat(24)}→ ${check.hint}`)
  }
  log('')

  const failures = checks.filter((check) => check.status === 'fail').length
  const warnings = checks.filter((check) => check.status === 'warn').length
  log(`${checks.length} 项检查：${checks.length - failures - warnings} 项通过，${warnings} 项提醒，${failures} 项失败。`)
  if (failures > 0) return 1

  const backend = resolveBackend(context.config, options.backend)
  if (backend === 'local') {
    log('')
    log('⚠ 当前生效的后端是 local —— 它不是沙箱，禁止用于演示。')
  }
  return 0
}

export async function collectChecks(context: CommandContext, options: CommandOptions): Promise<readonly Check[]> {
  const { config, env } = context
  const backend = resolveBackend(config, options.backend)
  const cellHost = resolveCellHost(config, backend, options.cellHost)

  return [
    checkNode(),
    checkBackend(backend),
    await checkDocker(backend, context.platform),
    checkUserNamespaces(),
    checkBubblewrap(context.platform),
    await checkPort('宿主面端口', config.broker.host, config.broker.hostPort),
    await checkPort('舱面端口', cellHost, config.broker.cellPort),
    checkCellHost(cellHost, backend),
    checkCellToken(config, env),
    checkUpstreams(config, env),
    checkEgress(config),
    checkMountPolicy(),
    checkAuditPath(config),
  ]
}

function checkNode(): Check {
  const required = [22, 18, 0]
  const current = process.versions.node.split('.').map(Number)
  const [major = 0, minor = 0] = current
  const ok = major > (required[0] ?? 22) || (major === (required[0] ?? 22) && minor >= (required[1] ?? 18))

  return {
    name: 'Node 版本',
    status: ok ? 'ok' : 'fail',
    detail: `v${process.versions.node}${ok ? '' : '（需要 >= 22.18：更低的版本默认不剥离 TypeScript 类型）'}`,
    ...(ok ? {} : { hint: '升级 Node，或者用 `node --experimental-strip-types` 显式打开。' }),
  }
}

function checkBackend(backend: string): Check {
  if (backend === 'docker') {
    return { name: '沙箱后端', status: 'ok', detail: 'docker（真隔离）' }
  }
  return {
    name: '沙箱后端',
    status: 'fail',
    detail: 'local —— 这不是沙箱，命令会以当前用户身份直接在宿主上执行',
    hint: '只在开发和自测时用。把配置里的 session.backend 改回 docker，或去掉 --backend local。',
  }
}

async function checkDocker(backend: string, platform: HostPlatform): Promise<Check> {
  const probe = await probeDocker(platform)
  if (probe.available) {
    return { name: 'docker', status: 'ok', detail: probe.detail }
  }
  return {
    name: 'docker',
    status: backend === 'docker' ? 'fail' : 'warn',
    detail: probe.detail,
    hint:
      backend === 'docker'
        ? '启动 docker 守护进程；确实用不了时，临时改用 --backend local（那不是沙箱）。'
        : '当前用的不是 docker 后端，所以不影响；但隔离也没了。',
  }
}

function checkUserNamespaces(): Check {
  const probe = probeUserNamespaces()
  return {
    name: 'user namespace',
    status: probe.enabled ? 'ok' : 'warn',
    detail: probe.enabled ? `可用（${probe.detail}）` : `不可用（${probe.detail}）`,
    ...(probe.enabled
      ? {}
      : { hint: 'docker 用不到它；但 bwrap 那类基于 userns 的隔离方案在这台机器上走不通。' }),
  }
}

function checkBubblewrap(platform: HostPlatform): Check {
  const present = isExecutableOnPath('bwrap', platform)
  return {
    name: 'bubblewrap',
    status: 'ok',
    detail: present ? '已安装（本阶段未使用，docker 是主实现）' : '未安装（本阶段不需要）',
  }
}

async function checkPort(name: string, host: string, port: number): Promise<Check> {
  const occupied = await isPortOpen(host, port)
  return {
    name,
    status: occupied ? 'warn' : 'ok',
    detail: `${host}:${port} ${occupied ? '已被占用' : '空闲'}`,
    ...(occupied
      ? { hint: '已被占用通常意味着已经有一个 broker 在跑（那就不必再起）或者别的程序占了它。' }
      : {}),
  }
}

function checkCellHost(cellHost: string, backend: string): Check {
  if (backend === 'local') {
    return { name: '舱面绑定地址', status: 'ok', detail: `${cellHost}（local 后端固定走回环）` }
  }
  if (cellHost === '172.17.0.1') {
    return {
      name: '舱面绑定地址',
      status: 'warn',
      detail: `${cellHost}（docker 默认网桥网关，网桥不存在时 bind 会失败）`,
      hint: 'docker 用的是自定义网络时，网关地址不是 172.17.0.1。用 `docker network inspect bridge` 确认。',
    }
  }
  return { name: '舱面绑定地址', status: 'ok', detail: cellHost }
}

function checkCellToken(config: AbxConfig, env: Readonly<Record<string, string | undefined>>): Check {
  const name = config.broker.cellTokenEnv
  const value = env[name]
  const present = value !== undefined && value.trim() !== ''

  if (present) {
    // 只报长度，不报值。doctor 的输出经常被整段贴进 issue。
    return { name: '舱令牌', status: 'ok', detail: `${name} 已设置（${value.trim().length} 字符）` }
  }
  return {
    name: '舱令牌',
    status: 'warn',
    detail: `${name} 未设置`,
    hint: 'abx broker 会生成一个并写到令牌文件；abx open 会从那里读，所以单机用法不受影响。',
  }
}

function checkUpstreams(config: AbxConfig, env: Readonly<Record<string, string | undefined>>): Check {
  if (config.upstreams.length === 0) {
    return { name: '上游凭据', status: 'warn', detail: '一个上游都没配', hint: '在配置的 upstreams 里加上要用的上游。' }
  }

  // 只检查「就位没有」，绝不打值。
  const missing: string[] = []
  for (const upstream of config.upstreams) {
    if (upstream.secretEnv !== null) {
      const value = env[upstream.secretEnv]
      if (value === undefined || value.trim() === '') missing.push(`${upstream.id}(${upstream.secretEnv})`)
      continue
    }
    if (upstream.secretFile !== null && !existsSync(upstream.secretFile)) {
      missing.push(`${upstream.id}(${upstream.secretFile})`)
    }
  }

  if (missing.length === 0) {
    return { name: '上游凭据', status: 'ok', detail: `${config.upstreams.length} 个上游就位（只检查了存在性，没有读取值）` }
  }
  return {
    name: '上游凭据',
    status: 'fail',
    detail: `缺：${missing.join(', ')}`,
    hint: '导出对应的环境变量，或把凭据写进 secretFile 指向的文件。',
  }
}

function checkEgress(config: AbxConfig): Check {
  if (config.egress.length === 0) {
    return {
      name: '出口白名单',
      status: 'warn',
      detail: '空的 —— 所有出网请求都会被 403',
      hint: '这是默认拒绝的默认值，不是坏了。按需往 egress.allow 里加域名。',
    }
  }

  const wildcards = listWildcardPatterns(config.egress)
  if (wildcards.length > 0) {
    return {
      name: '出口白名单',
      status: 'warn',
      detail: `${config.egress.length} 条，其中 ${wildcards.length} 条是通配：${wildcards.join(', ')}`,
      hint: '通配规则覆盖的域名比看上去多。确认一下每一条都是有意写的。',
    }
  }
  return { name: '出口白名单', status: 'ok', detail: `${config.egress.length} 条，全部是精确域名` }
}

function checkMountPolicy(): Check {
  return {
    name: '挂载策略',
    status: 'ok',
    detail: MOUNT_POLICY.summary,
  }
}

function checkAuditPath(config: AbxConfig): Check {
  const auditPath = path.resolve(config.broker.auditPath)
  const directory = path.dirname(auditPath)

  if (!existsSync(directory)) {
    return {
      name: '审计落盘',
      status: 'warn',
      detail: `${auditPath} 的目录还不存在，第一次写的时候会创建`,
    }
  }
  try {
    accessSync(directory, constants.W_OK)
    return { name: '审计落盘', status: 'ok', detail: auditPath }
  } catch {
    return {
      name: '审计落盘',
      status: 'fail',
      detail: `目录不可写：${directory}`,
      hint: '审计写不进去时请求不会因此被拦，但会失去全部留痕。换一个可写的路径。',
    }
  }
}

/** 宿主环境里有没有那类「不该带进舱内」的变量。只报名，不报值。 */
export function findDangerousHostEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return DANGEROUS_HOST_ENV_NAMES.filter((name) => env[name] !== undefined)
}
