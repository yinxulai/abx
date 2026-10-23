/**
 * local 后端的用例。
 *
 * 这个后端**不是沙箱**，所以这里的用例验证的不是隔离（它没有隔离），
 * 而是：它有没有老老实实说自己不是沙箱、有没有把宿主凭据剃干净、
 * 有没有把 HOME 改到任务目录。这几点恰恰是「用着用着就忘了它不是沙箱」的
 * 那类事故的防线。
 *
 * 会真的起进程（`node -e ...`），因为「能不能跑起来」在这个后端上是唯一有意义的验证。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxSpec } from './backend'
import { LOCAL_BACKEND_WARNING, createLocalBackend, probeUserNamespaces } from './local-backend'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function taskDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'abx-local-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  const directory = taskDir()
  return {
    cellId: 'test-cell',
    agentId: 'claude',
    command: [process.execPath, '-e', 'console.log("hello from the cell")'],
    taskDir: directory,
    workdir: '/workspace',
    // local 后端跑在宿主上，`HOME` 是它自己改写到任务目录的（见 local-backend.ts），
    // 这个值在这儿只是把接口填满：跨后端的形状必须一样。
    cellHome: '/home/node',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789/u/anthropic', ANTHROPIC_AUTH_TOKEN: 'abx-placeholder' },
    forbiddenEnvNames: ['ANTHROPIC_API_KEY'],
    limits: { memory: '2g', pids: 256, cpus: 2 },
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    tmpfsSizeMb: 64,
    ...overrides,
  }
}

interface Captured {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

async function run(current: SandboxSpec): Promise<Captured> {
  const backend = createLocalBackend()
  let stdout = ''
  let stderr = ''
  const handle = await backend.create(current, {
    mode: 'pipe',
    onStdout: (chunk) => (stdout += chunk.toString('utf8')),
    onStderr: (chunk) => (stderr += chunk.toString('utf8')),
  })
  const exit = await handle.exit
  return { stdout, stderr, code: exit.code }
}

describe('local 后端必须自曝身份', () => {
  it('isRealSandbox 是 false', () => {
    expect(createLocalBackend().isRealSandbox).toBe(false)
  })

  it('warning 里明确写出「不是沙箱」和「禁止用于演示」', () => {
    const warning = createLocalBackend().warning
    expect(warning).toContain('不是沙箱')
    expect(warning).toContain('禁止用于演示')
    expect(warning).toBe(LOCAL_BACKEND_WARNING)
  })

  it('warning 里说清楚了没有哪几样隔离', () => {
    expect(LOCAL_BACKEND_WARNING).toContain('文件系统隔离')
    expect(LOCAL_BACKEND_WARNING).toContain('资源限额')
    expect(LOCAL_BACKEND_WARNING).toContain('网络隔离')
  })

  it('id 是 local', () => {
    expect(createLocalBackend().id).toBe('local')
  })
})

describe('local 后端真的能跑', () => {
  it('命令跑起来，输出被收到', async () => {
    const result = await run(spec())
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello from the cell')
  })

  it('工作目录是任务目录', async () => {
    const current = spec({ command: [process.execPath, '-e', 'console.log(process.cwd())'] })
    const result = await run(current)
    // macOS 的 /tmp 是符号链接，用 realpath 比更稳。
    expect(result.stdout.trim()).toBe(current.taskDir)
  })

  it('注入了配置里的环境变量', async () => {
    const current = spec({ command: [process.execPath, '-e', 'console.log(process.env.ANTHROPIC_BASE_URL)'] })
    const result = await run(current)
    expect(result.stdout.trim()).toBe('http://127.0.0.1:8789/u/anthropic')
  })

  it('非零退出码原样带回来', async () => {
    const result = await run(spec({ command: [process.execPath, '-e', 'process.exit(3)'] }))
    expect(result.code).toBe(3)
  })

  it('命令不存在时给出可读的报错', async () => {
    // spawn 失败是异步的：`create` 会先返回 handle，错误从 `exit` 上抛出来。
    const backend = createLocalBackend()
    const handle = await backend.create(spec({ command: ['abx-definitely-not-a-command'] }), {
      mode: 'pipe',
      onStdout: () => undefined,
      onStderr: () => undefined,
    })
    await expect(handle.exit).rejects.toThrow(/起不了 abx-definitely-not-a-command/)
  })
})

describe('local 后端的环境脱敏', () => {
  it('凭据变量混进 env 时拒绝启动', async () => {
    const backend = createLocalBackend()
    await expect(
      backend.create(spec({ env: { ANTHROPIC_API_KEY: 'sk-ant-real' } }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow(/不能注入舱内/)
  })

  it('注入了 HOME 与项目目录，HOME 指向任务目录', async () => {
    // 不指过去的话，工具会顺着真实的 ~ 去找 .aws/credentials 这些文件。
    const current = spec({
      command: [process.execPath, '-e', 'console.log(process.env.HOME + "|" + process.env.ABX_PROJECT_DIR)'],
    })
    const result = await run(current)
    expect(result.stdout.trim()).toBe(`${current.taskDir}|${current.taskDir}`)
  })

  it('宿主上像凭据的环境变量不会跟着漏进来', async () => {
    const current = spec({
      command: [process.execPath, '-e', 'console.log(JSON.stringify({t: process.env.GITHUB_TOKEN, k: process.env.MY_API_KEY, s: process.env.SSH_AUTH_SOCK}))'],
    })
    const result = await run(current)
    expect(result.stdout.trim()).toBe('{}')
  })

  it('handle 上能拿到脱敏后的环境，且不含被剃掉的变量', async () => {
    const backend = createLocalBackend()
    const handle = await backend.create(spec(), { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined })
    expect(handle.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8789/u/anthropic')
    expect(handle.env['ANTHROPIC_API_KEY']).toBeUndefined()
    await handle.exit
  })

  it('handle 上报出「本应挂什么」，两种后端形状一致', async () => {
    const current = spec()
    const backend = createLocalBackend()
    const handle = await backend.create(current, { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined })
    expect(handle.mounts).toEqual([{ source: current.taskDir, target: '/workspace', mode: 'rw' }])
    expect(handle.backendId).toBe('local')
    await handle.exit
  })
})

describe('probeUserNamespaces', () => {
  it('max_user_namespaces 为 0 时判定为禁用', () => {
    const files: Record<string, string> = { '/proc/sys/user/max_user_namespaces': '0\n' }
    const result = probeUserNamespaces((path) => {
      const content = files[path]
      if (content === undefined) throw new Error('ENOENT')
      return content
    })
    expect(result.enabled).toBe(false)
    expect(result.detail).toContain('0')
  })

  it('unprivileged_userns_clone 为 0 时也判定为禁用', () => {
    const files: Record<string, string> = {
      '/proc/sys/user/max_user_namespaces': '55722\n',
      '/proc/sys/kernel/unprivileged_userns_clone': '0\n',
    }
    const result = probeUserNamespaces((path) => {
      const content = files[path]
      if (content === undefined) throw new Error('ENOENT')
      return content
    })
    expect(result.enabled).toBe(false)
  })

  it('两个开关都正常时判定为可用', () => {
    const files: Record<string, string> = {
      '/proc/sys/user/max_user_namespaces': '55722\n',
      '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
    }
    const result = probeUserNamespaces((path) => {
      const content = files[path]
      if (content === undefined) throw new Error('ENOENT')
      return content
    })
    expect(result.enabled).toBe(true)
  })

  it('读不到 /proc 时判定为不可用，而不是「大概可以吧」', () => {
    const result = probeUserNamespaces(() => {
      throw new Error('ENOENT')
    })
    expect(result.enabled).toBe(false)
  })
})
