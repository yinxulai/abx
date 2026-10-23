/**
 * docker 后端的用例。
 *
 * 本机 docker 守护进程没起来，所以这里**不**起真容器。它验证的是命令行参数——
 * 也就是「到底挂了什么、开了什么权限、注入了什么」。这恰恰是 docker 后端里
 * 最该被钉死的部分：一个多出来的 `--volume` 或者少掉的 `--cap-drop`，
 * 靠跑一次容器是看不出来的，靠断言 argv 是一眼就能看出来的。
 *
 * 「真容器能不能起来」这件事没验证，如实写在 docs/PHASE1-REPORT.md 里。
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { SandboxSpec } from './backend'
import { buildDockerArgs, containerName, isExecutableOnPath } from './docker-backend'
import { MOUNT_POLICY } from './mount-policy'

const TASK_DIR = '/home/dev/projects/thing'

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    cellId: 'claude-20261023-ab12cd',
    agentId: 'claude',
    command: ['claude'],
    taskDir: TASK_DIR,
    workdir: '/workspace',
    env: { ANTHROPIC_AUTH_TOKEN: 'abx-placeholder-anthropic', ANTHROPIC_BASE_URL: 'http://172.17.0.1:8789/u/anthropic' },
    forbiddenEnvNames: ['ANTHROPIC_API_KEY'],
    limits: { memory: '2g', pids: 256, cpus: 2 },
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    tmpfsSizeMb: 64,
    ...overrides,
  }
}

function argsFor(overrides: Partial<SandboxSpec> = {}): readonly string[] {
  const current = spec(overrides)
  return buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir))
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function allFlagValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = []
  args.forEach((arg, index) => {
    if (arg === flag) {
      const value = args[index + 1]
      if (value !== undefined) values.push(value)
    }
  })
  return values
}

describe('buildDockerArgs', () => {
  it('一次性容器：--rm', () => {
    expect(argsFor()).toContain('--rm')
  })

  it('只挂任务目录，且可写', () => {
    const volumes = allFlagValues(argsFor(), '--volume')
    expect(volumes).toEqual([`${TASK_DIR}:/workspace:rw`])
  })

  it('绝不挂载主目录、/home、docker socket', () => {
    const volumes = allFlagValues(argsFor(), '--volume')
    expect(volumes.some((volume) => volume.includes('/home/dev:'))).toBe(false)
    expect(volumes.some((volume) => volume.startsWith('/home:'))).toBe(false)
    expect(volumes.some((volume) => volume.includes('docker.sock'))).toBe(false)
    expect(volumes).toHaveLength(1)
  })

  it('非 root 运行', () => {
    expect(flagValue(argsFor(), '--user')).toBe('1000:1000')
    expect(flagValue(argsFor(), '--user')).not.toBe('root')
    expect(flagValue(argsFor(), '--user')).not.toBe('0')
  })

  it('资源限额三项都在', () => {
    expect(flagValue(argsFor(), '--memory')).toBe('2g')
    expect(flagValue(argsFor(), '--pids-limit')).toBe('256')
    expect(flagValue(argsFor(), '--cpus')).toBe('2')
  })

  it('限额跟着配置走', () => {
    const args = argsFor({ limits: { memory: '512m', pids: 64, cpus: 0.5 } })
    expect(flagValue(args, '--memory')).toBe('512m')
    expect(flagValue(args, '--pids-limit')).toBe('64')
    expect(flagValue(args, '--cpus')).toBe('0.5')
  })

  it('丢掉所有 capability，并禁止提权', () => {
    expect(flagValue(argsFor(), '--cap-drop')).toBe('ALL')
    expect(flagValue(argsFor(), '--security-opt')).toBe('no-new-privileges')
  })

  it('根文件系统只读，/tmp 走 tmpfs', () => {
    const args = argsFor()
    expect(args).toContain('--read-only')
    expect(flagValue(args, '--tmpfs')).toBe('/tmp:rw,noexec,nosuid,size=64m')
  })

  it('带上 --init，僵尸进程不会堆在容器里', () => {
    expect(argsFor()).toContain('--init')
  })

  it('不申请特权模式', () => {
    const args = argsFor()
    expect(args).not.toContain('--privileged')
    expect(args).not.toContain('--pid=host')
    expect(args.some((arg) => arg.includes('--network=host'))).toBe(false)
  })

  it('环境变量以 --env 注入，且不含被点名禁用的名字', () => {
    const envs = allFlagValues(argsFor(), '--env')
    expect(envs).toEqual([
      'ANTHROPIC_AUTH_TOKEN=abx-placeholder-anthropic',
      'ANTHROPIC_BASE_URL=http://172.17.0.1:8789/u/anthropic',
    ])
    expect(envs.some((entry) => entry.startsWith('ANTHROPIC_API_KEY='))).toBe(false)
  })

  it('环境变量顺序稳定，同一份配置两次结果一致', () => {
    // 不排序的话每次 argv 顺序都不一样，测试和 diff 都没法看。
    expect(argsFor()).toEqual(argsFor())
  })

  it('工作目录和镜像接在最后，后面跟命令', () => {
    const args = argsFor({ command: ['claude', '--verbose'] })
    const imageIndex = args.indexOf('node:22-slim')
    expect(args.slice(imageIndex)).toEqual(['node:22-slim', 'claude', '--verbose'])
  })

  it('容器带标签，方便事后认领', () => {
    const labels = allFlagValues(argsFor(), '--label')
    expect(labels).toContain('abx.cell-id=claude-20261023-ab12cd')
    expect(labels).toContain('abx.agent=claude')
  })
})

describe('containerName', () => {
  it('加前缀，便于一眼认出是气闸起的', () => {
    expect(containerName('claude-1')).toBe('abx-claude-1')
  })

  it('非法字符被替换，否则 docker 会直接拒绝这个名字', () => {
    expect(containerName('a/b c:d')).toBe('abx-a-b-c-d')
  })

  it('结果符合 docker 的命名规则', () => {
    expect(containerName('claude-2026/x')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  })
})

describe('isExecutableOnPath', () => {
  it('绝对路径直接查文件是否存在且可执行', () => {
    expect(isExecutableOnPath('/bin/sh')).toBe(true)
    expect(isExecutableOnPath('/definitely/not/here')).toBe(false)
  })

  it('PATH 上的命令能查到', () => {
    expect(isExecutableOnPath('sh')).toBe(true)
  })

  it('不存在的命令查不到', () => {
    expect(isExecutableOnPath('abx-definitely-not-a-command')).toBe(false)
  })
})

describe('后端契约', async () => {
  const { createDockerBackend } = await import('./docker-backend')

  it('声明自己是真沙箱', () => {
    const backend = createDockerBackend()
    expect(backend.id).toBe('docker')
    expect(backend.isRealSandbox).toBe(true)
    expect(backend.warning).toBeNull()
  })

  it('凭据变量混进 env 时拒绝启动，且不走到 spawn', async () => {
    let spawned = false
    const backend = createDockerBackend({
      spawnProcess: (() => {
        spawned = true
        return new EventEmitter()
      }) as never,
    })

    await expect(
      backend.create(spec({ env: { ANTHROPIC_API_KEY: 'sk-ant-real' } }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow(/不能注入舱内/)
    expect(spawned).toBe(false)
  })

  it('错误信息里报变量名，不报值', async () => {
    const backend = createDockerBackend({ spawnProcess: (() => new EventEmitter()) as never })
    const error = await backend
      .create(spec({ env: { ANTHROPIC_API_KEY: 'sk-ant-super-secret' } }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
      .then(
        () => null,
        (reason: Error) => reason,
      )

    expect(error).not.toBeNull()
    expect(error?.message).toContain('ANTHROPIC_API_KEY')
    expect(error?.message).not.toContain('sk-ant-super-secret')
  })

  it('docker 起不来时给一句能照着做的提示', async () => {
    const backend = createDockerBackend({
      spawnProcess: (() => {
        const child = new EventEmitter()
        // spawn 失败是异步发 error 事件，不是同步抛。
        setImmediate(() => child.emit('error', new Error('ENOENT')))
        return child as never
      }) as never,
    })

    const handle = await backend.create(spec(), { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined })
    await expect(handle.exit).rejects.toThrow(/abx doctor/)
  })
})
