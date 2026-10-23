/**
 * `createBackend` 的用例。
 *
 * 这个函数是「后端选择」这条策略的落点。下面钉的不是某个后端怎么干活，而是
 * **它选出了谁**：
 *
 *   1. 每个受支持的 id 都落到它自己那个实现上——`docker` 就是 docker，
 *      `local` 就是 local，两者不许在某一条件下互相顶替；
 *   2. 不是 `SandboxBackendId` 的值（配置写错、命令行拼错、以后有人手改 JSON）
 *      必须**响亮失败**，而不是拿到一个能跑的后端；
 *   3. docker 起不来时，失败原样浮上来，**不**降级成 local。
 *
 * 第 3 条是这里唯一会起真进程的用例：它把 `PATH` 指到一个空目录，于是 `docker`
 * 这个名字在哪都找不到——「守护进程没起来 / 可执行文件不在」正是要模拟的那种失败。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SANDBOX_BACKEND_IDS } from '@abx/contracts'
import { makeConfig } from '@abx/contracts/test-support'
import { RUNNING_PLATFORM, RUNNING_VOCABULARY } from '../test-support'
import type { SandboxBackend, SandboxSpec } from './backend'
import { createBackend } from './index'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** 造一个后端，把「造出来了什么」和「为什么没造出来」一起带回来。 */
function attempt(id: string): { readonly backend: SandboxBackend | null; readonly error: Error | null } {
  try {
    return { backend: createBackend(id), error: null }
  } catch (thrown) {
    return { backend: null, error: thrown instanceof Error ? thrown : new Error(String(thrown)) }
  }
}

/**
 * 一份能过挂载闸的会话输入。
 *
 * 任务目录是假的（不存在也没关系）：这个用例要验的是「起不来得有个响亮说法」，
 * 不是「能不能真起一个容器」。
 */
function spec(): SandboxSpec {
  return {
    cellId: 'backend-factory-cell',
    agentId: 'claude',
    platform: RUNNING_PLATFORM,
    command: ['claude'],
    allocateTty: false,
    taskDir: RUNNING_VOCABULARY.taskDir,
    workdir: '/workspace',
    cellHome: '/home/node',
    env: {},
    forbiddenEnvNames: [],
    limits: { memory: '2g', pids: 256, cpus: 2 },
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    tmpfsSizeMb: 64,
  }
}

describe('createBackend：每个 id 落到它自己的实现上', () => {
  it('受支持的 id 造出来的后端报的就是这个 id', () => {
    // 逐个契约里的 id 走一遍，而不是照抄一份名单：以后加了 id，这条用例会自动
    // 跟着查新 id（而「加了 id 没实现」在编译期就过不去）。
    for (const id of SANDBOX_BACKEND_IDS) {
      expect(createBackend(id).id).toBe(id)
    }
  })

  it('docker 声明自己是真沙箱，没有警告', () => {
    const backend = createBackend('docker')
    expect(backend.isRealSandbox).toBe(true)
    expect(backend.warning).toBeNull()
  })

  it('local 声明自己不是沙箱，而且必须给出警告', () => {
    // 这条不是文案检查：`isRealSandbox: false` 只有配上非空 `warning`，
    // 上层的「强制打警告」才有话可说。两个一起才算声明清楚。
    const backend = createBackend('local')
    expect(backend.isRealSandbox).toBe(false)
    expect(backend.warning).not.toBeNull()
    expect(backend.warning?.trim()).not.toBe('')
  })

  it('两个后端不是同一个东西，谁也不许顶替谁', () => {
    expect(createBackend('local').id).not.toBe(createBackend('docker').id)
    expect(createBackend('local').isRealSandbox).not.toBe(createBackend('docker').isRealSandbox)
  })
})

describe('createBackend：未知 id 响亮失败', () => {
  it('错误信息里有那个 id，也有支持名单', () => {
    const { error } = attempt('podman')
    expect(error).not.toBeNull()
    expect(error?.message).toContain('"podman"')
    for (const id of SANDBOX_BACKEND_IDS) expect(error?.message).toContain(`"${id}"`)
  })

  it('什么都不造——尤其不造一个 local 出来充数', () => {
    // 这条是整件事的要害：失败必须表现为「什么都没有」，而不是「给了一个没有隔离
    // 的后端，调用方自己看着办」。拿不到东西会立刻炸在这个调用点上，
    // 拿到 local 则会一路跑到「会话看起来起好了」。
    const { backend } = attempt('podman')
    expect(backend).toBeNull()
  })

  it('大小写不同不算同一个后端', () => {
    // 配置里写 "Docker" 是写错了，不是「等价写法」。悄悄接受它等于埋一个
    // 「哪些 id 真的能用」的暗规则。
    expect(attempt('Docker').backend).toBeNull()
  })
})

describe('createBackend：默认后端是 docker', () => {
  it('配置里不写 backend 时，解析出来是 docker，造出来的也是 docker', () => {
    // 「默认 local」等于「默认没有沙箱」。这条断言从配置一路走到工厂，
    // 中间任何一节把默认值换掉都会红。
    const config = makeConfig()
    expect(config.session.backend).toBe('docker')
    expect(createBackend(config.session.backend).id).toBe('docker')
    expect(createBackend(config.session.backend).isRealSandbox).toBe(true)
  })
})

describe('createBackend：docker 不可用时不降级', () => {
  it('失败原样浮上来，不会换成 local 把这次会话跑成', async () => {
    const backend = createBackend('docker')
    // 降级只可能发生在这个工厂里，而这里给的就是 docker。
    expect(backend.id).toBe('docker')

    // 把 PATH 指到一个空目录：`docker` 这个名字于是谁都不认识。
    // 这就是「本机没装 docker / 守护进程没起来」在 spawn 那一层的样子。
    const emptyPath = mkdtempSync(path.join(tmpdir(), 'abx-no-docker-'))
    const savedPath = process.env['PATH']
    cleanups.push(() => rmSync(emptyPath, { recursive: true, force: true }))
    process.env['PATH'] = emptyPath
    try {
      const handle = await backend.create(spec(), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
      // 失败落在 exit 上，而不是被吞掉、更不是换个后端重来一遍。
      // 这里 PATH 是空目录，所以失败的具体形态是 `ENOENT` —— 说的是
      // 「这台机器上没有 docker 这个可执行文件」，而不是「守护进程没起」。
      await expect(handle.exit).rejects.toThrow(/找不到 docker/)
    } finally {
      if (savedPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = savedPath
    }
  })
})
