/**
 * docker 后端：本阶段的主实现。
 *
 * 隔离手段，一条一条对着需求：
 *   - **一次性容器**：`docker run --rm`，退出即销毁，不留持久化痕迹；
 *   - **只挂任务目录**，可写；不挂 `/home`，不挂用户主目录（见 `mount-policy.ts`）；
 *   - **非 root**：`--user`；没有 sudo（镜像里本来就没有）；
 *   - **资源限额**：`--memory` / `--pids-limit` / `--cpus`；
 *   - 外加几条需求没点名但同类的：`--cap-drop ALL`、`--security-opt no-new-privileges`、
 *     `--read-only` 根文件系统、`/tmp` 用 tmpfs、`--init` 收僵尸进程。
 *
 * 命令行参数由 `buildDockerArgs` 纯函数拼出来，所以「到底挂了什么、开了什么权限」
 * 可以脱离 docker 守护进程直接断言——本机 docker 没起来的时候，这仍然是有意义的测试。
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import type { SandboxBackend, SandboxHandle, SandboxIo, SandboxMount, SandboxSpec } from './backend'
import { assertNoForbiddenEnv } from './backend'
import { MOUNT_POLICY, assertMountPolicy } from './mount-policy'

export interface DockerBackendOptions {
  /** docker 可执行文件。 */
  readonly dockerPath?: string
  /** 注入 spawn，测试里用来观察参数而不真的起容器。 */
  readonly spawnProcess?: typeof spawn
}

export function buildDockerArgs(spec: SandboxSpec, mounts: readonly SandboxMount[]): readonly string[] {
  const args: string[] = [
    'run',
    // 退出即销毁。这是「不留持久化痕迹」的实现方式——不是靠事后清理，
    // 而是压根不给它留下一个可以被重新启动的容器。
    '--rm',
    // 交互 + TTY：agent 命令行多半需要。
    '--interactive',
    '--tty',
    // pid 1 交给 tini，负责回收僵尸进程。
    '--init',
    '--name',
    containerName(spec.cellId),
    '--label',
    `abx.cell-id=${spec.cellId}`,
    '--label',
    `abx.agent=${spec.agentId}`,
    // 非 root。
    '--user',
    spec.user,
    '--workdir',
    spec.workdir,
    // 资源限额。
    '--memory',
    spec.limits.memory,
    '--pids-limit',
    String(spec.limits.pids),
    '--cpus',
    String(spec.limits.cpus),
    '--network',
    spec.network,
    // 权限收紧。
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // 根文件系统只读。可写的只有任务目录和下面的 /tmp，
    // 「删不掉机器」这条靠的就是它。
    '--read-only',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${spec.tmpfsSizeMb}m`,
  ]

  for (const mount of mounts) {
    args.push('--volume', `${mount.source}:${mount.target}:${mount.mode}`)
  }

  // 环境变量排序后输出：让 `buildDockerArgs` 的结果可比较，
  // 否则同一份配置每次跑出来的 argv 顺序都不一样，测试和 diff 都没法看。
  for (const name of Object.keys(spec.env).sort()) {
    args.push('--env', `${name}=${spec.env[name] ?? ''}`)
  }

  args.push(spec.image, ...spec.command)
  return args
}

export function containerName(cellId: string): string {
  // docker 的容器名只允许 [a-zA-Z0-9][a-zA-Z0-9_.-]*。
  return `abx-${cellId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, '-')
}

export function createDockerBackend(options: DockerBackendOptions = {}): SandboxBackend {
  const dockerPath = options.dockerPath ?? 'docker'
  const spawnProcess = options.spawnProcess ?? spawn

  return {
    id: 'docker',
    isRealSandbox: true,
    warning: null,

    async create(spec: SandboxSpec, io: SandboxIo): Promise<SandboxHandle> {
      // 起容器之前的三道检查。顺序是「先便宜后昂贵」：
      // 环境变量泄漏是纯内存判断，挂载是纯字符串判断，命令行执行放最后。
      assertNoForbiddenEnv(spec)

      const taskDir = path.resolve(spec.taskDir)
      // 生成好的 agent 配置跟着一起进挂载清单：**每个文件一个只读挂载点**。
      // 只读与「逐个文件」不是这里的选择，是 `MOUNT_POLICY.buildMounts` 的构造结果——
      // 这一层没有把它改成 rw 或者改成目录的入口。
      const agentConfigFiles = spec.agentConfigFiles ?? []
      const mounts = MOUNT_POLICY.buildMounts(taskDir, spec.workdir, agentConfigFiles)
      assertMountPolicy({ mounts, taskDir, workdir: spec.workdir, agentConfigFiles })

      const args = buildDockerArgs(spec, mounts)
      const child = spawnProcess(dockerPath, [...args], {
        stdio: io.mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      })

      if (io.mode === 'pipe') {
        child.stdout?.on('data', (chunk: Buffer) => io.onStdout(chunk))
        child.stderr?.on('data', (chunk: Buffer) => io.onStderr(chunk))
      }

      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', (error: Error) => {
          reject(
            new Error(
              `起不了 docker（${dockerPath}）：${error.message}。` +
                `docker 守护进程没在跑时就是这个错——用 abx doctor 看一眼，` +
                `或者临时改用 --backend local（注意那不是沙箱）。`,
            ),
          )
        })
        child.on('exit', (code, signal) => resolve({ code, signal: signal ?? null }))
      })

      return {
        cellId: spec.cellId,
        backendId: 'docker',
        mounts,
        env: spec.env,
        exit,
        async stop(): Promise<void> {
          if (child.exitCode !== null || child.signalCode !== null) return
          child.kill('SIGTERM')
        },
      }
    },
  }
}

export interface DockerProbeResult {
  readonly available: boolean
  readonly version: string | null
  readonly detail: string
}

/**
 * 探一下 docker 到底能不能用。
 *
 * 判据是 `docker version --format {{.Server.Version}}`，不是 `docker --version`：
 * 后者只说明客户端装了。**本机现在就是这个状态**——CLI 在，守护进程没起，
 * `docker --version` 会开开心心地打印版本号，然后 `docker run` 直接失败。
 */
export async function probeDocker(dockerPath = 'docker'): Promise<DockerProbeResult> {
  if (!isExecutableOnPath(dockerPath)) {
    return { available: false, version: null, detail: `找不到 ${dockerPath} 可执行文件` }
  }

  return await new Promise<DockerProbeResult>((resolve) => {
    const child = spawn(dockerPath, ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error: Error) => resolve({ available: false, version: null, detail: error.message }))
    child.on('exit', (code) => {
      const version = stdout.trim()
      if (code === 0 && version !== '') {
        resolve({ available: true, version, detail: `docker 守护进程可用：${version}` })
        return
      }
      resolve({
        available: false,
        version: null,
        detail: firstLine(stderr) || `docker version 退出码 ${code}`,
      })
    })
  })
}

/** `docker` 在不在 PATH 上。绝对路径就直接查文件。 */
export function isExecutableOnPath(command: string): boolean {
  if (command.includes(path.sep)) {
    try {
      accessSync(command, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const searchPath = process.env['PATH'] ?? ''
  return searchPath.split(path.delimiter).some((directory) => {
    if (directory === '') return false
    try {
      accessSync(path.join(directory, command), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
