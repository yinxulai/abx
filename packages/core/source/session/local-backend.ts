/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  这个后端不是沙箱，禁止用于演示。                                        ║
 * ║                                                                          ║
 * ║  它在当前用户的身份下、在宿主上直接执行命令。没有命名空间、没有 cgroup、 ║
 * ║  没有文件系统隔离。它能读到你的 SSH 私钥、你的云凭据、你的整个主目录，  ║
 * ║  能删掉你的机器。它做的全部事情只有两件：换一个工作目录、换一批环境变量。║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 它存在的唯一理由：本机 docker 守护进程没起来（本项目的开发机就是这种情况），
 * 而 bwrap 需要的 user namespace 又可能被发行版禁掉。这时候如果只有 docker 一条路，
 * 整个会话编排逻辑就完全没法验证——包括环境变量注入、审计、broker 串联这些
 * **跟隔离无关**的部分。
 *
 * 所以它是一条「能把逻辑跑通」的路径，不是一条「能将就用」的路径。
 * 判断标准很简单：任何要给别人看的东西，都不能用这个后端跑。
 *
 * 代码层面做了三件事让它不至于太危险：
 *   1. `isRealSandbox: false` + `warning`，CLI 拿到就强制打警告，跑之前还要再确认一次；
 *   2. 环境变量走 `scrubEnv` 的三层黑名单，宿主的凭据不会被顺手带进去；
 *   3. `HOME` 被改写到任务目录——否则 `~/.aws/credentials` 之类的默认查找路径
 *      会直接指向真实的宿主主目录。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { SandboxBackend, SandboxHandle, SandboxIo, SandboxMount, SandboxSpec } from './backend'
import { assertNoForbiddenEnv } from './backend'
import { MOUNT_POLICY } from './mount-policy'
import { scrubEnv } from './env'

/** 打印在终端上的警告原文。CLI 和 doctor 用的是同一份，避免两处措辞不一致。 */
export const LOCAL_BACKEND_WARNING = [
  '⚠  local 后端不是沙箱，禁止用于演示。',
  '   命令会以当前用户身份直接在宿主上执行，没有文件系统隔离、没有资源限额、',
  '   没有网络隔离——它能读到你的主目录、你的凭据，也能删掉你的机器。',
  '   它只用来在 docker 不可用时验证会话编排的逻辑。',
].join('\n')

export interface LocalBackendOptions {
  readonly spawnProcess?: typeof spawn
  /** 覆盖当前环境，测试用。 */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
}

export function createLocalBackend(options: LocalBackendOptions = {}): SandboxBackend {
  const spawnProcess = options.spawnProcess ?? spawn
  const baseEnv = options.baseEnv ?? process.env

  return {
    id: 'local',
    isRealSandbox: false,
    warning: LOCAL_BACKEND_WARNING,

    async create(spec: SandboxSpec, io: SandboxIo): Promise<SandboxHandle> {
      assertNoForbiddenEnv(spec)

      const taskDir = path.resolve(spec.taskDir)
      // 挂载清单照样算出来并挂到 handle 上——不是为了挂载（本地后端没有挂载这回事），
      // 而是为了让 CLI 和审计能报出「这次会话本应挂什么」。两种后端在这一点上
      // 保持同样的形状，上层就不用分叉。
      const mounts: readonly SandboxMount[] = MOUNT_POLICY.buildMounts(taskDir, spec.workdir)

      const scrubbed = scrubEnv(baseEnv, {
        forbiddenNames: spec.forbiddenEnvNames,
        overrides: {
          // HOME 指到任务目录：不这么做的话，工具会顺着真实的 `~` 去找
          // `.aws/credentials`、`.config/gh/hosts.yml` 这些文件。
          HOME: taskDir,
          // 舱内的「工作目录」概念在本地后端就是任务目录本身。
          ABX_PROJECT_DIR: taskDir,
        },
      })

      const env = { ...scrubbed.env, ...spec.env }

      const [command, ...args] = spec.command
      if (command === undefined) throw new Error('local 后端需要一个非空的命令')

      const child = spawnProcess(command, args, {
        cwd: taskDir,
        env,
        stdio: io.mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      })

      if (io.mode === 'pipe') {
        child.stdout?.on('data', (chunk: Buffer) => io.onStdout(chunk))
        child.stderr?.on('data', (chunk: Buffer) => io.onStderr(chunk))
      }

      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', (error: Error) => reject(new Error(`起不了 ${command}：${error.message}`)))
        child.on('exit', (code, signal) => resolve({ code, signal: signal ?? null }))
      })

      return {
        cellId: spec.cellId,
        backendId: 'local',
        mounts,
        env,
        exit,
        async stop(): Promise<void> {
          if (child.exitCode !== null || child.signalCode !== null) return
          child.kill('SIGTERM')
        },
      }
    },
  }
}

/**
 * user namespace 到底能不能用。
 *
 * 有它才能用 bwrap 那类基于 userns 的隔离；被发行版禁掉时（不少发行版默认关，
 * 因为内核漏洞面太大），doctor 应该说出来——因为这时候哪怕想绕过 docker
 * 也还有别的路，而不是只能退到 local。
 */
export interface UsernsProbeResult {
  readonly enabled: boolean
  readonly detail: string
}

export function probeUserNamespaces(readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): UsernsProbeResult {
  let maxNamespaces: number | null = null
  try {
    maxNamespaces = Number(readFile('/proc/sys/user/max_user_namespaces').trim())
  } catch {
    return { enabled: false, detail: '读不到 /proc/sys/user/max_user_namespaces（可能不是 Linux）' }
  }

  if (maxNamespaces === 0) {
    return { enabled: false, detail: 'max_user_namespaces = 0，user namespace 被禁用了' }
  }

  // Debian/Ubuntu 专有开关，存在且为 0 时才算禁用；不存在是正常的（多数发行版没有这个文件）。
  try {
    const clone = readFile('/proc/sys/kernel/unprivileged_userns_clone').trim()
    if (clone === '0') {
      return { enabled: false, detail: 'unprivileged_userns_clone = 0，非特权用户不能建 user namespace' }
    }
  } catch {
    // 文件不存在，说明这个内核不需要它。
  }

  return { enabled: true, detail: `max_user_namespaces = ${maxNamespaces}` }
}
