/**
 * 打开动作的用例。
 *
 * 这里**不弹任何窗口**：真实实现在测试里是灾难，而且它验不了最重要的那条规矩。
 * 要验的是「到底跑了什么 argv」——所以 `spawn` 被换成一个记账的替身，
 * 而平台是传进去的（开发机是 linux，不等于只能用 linux 的规则验）。
 *
 * 最重要的那条：**文件名永远是一个独立的 argv 元素，不是拼进命令字符串的一部分。**
 * 那一个用例（`report; rm -rf ~.pdf`）就是「打开动作不经过 shell」这句话本身。
 */

import { describe, expect, it } from 'vitest'
import {
  OpenError,
  createSystemOpener,
  openCommandFor,
  type OpenSpawnOptions,
  type OpenedProcess,
  type SpawnFunction,
} from './opener'

interface RecordedRun {
  readonly command: string
  readonly args: readonly string[]
  readonly options: OpenSpawnOptions
  unrefed: boolean
}

/**
 * 一个记账用的 `spawn` 替身。
 *
 * `outcome` 决定它起来之后发哪个事件：`'spawn'` 是成功，`'error'` 是「命令不存在」
 * 那一类失败。事件用 `setImmediate` 发，保证监听器已经挂上了——真实的 node 也是
 * 下一个 tick 才发，这不是为了迁就替身，而是照着真东西的形状做。
 */
function fakeSpawn(outcome: 'spawn' | 'error' = 'spawn'): { launch: SpawnFunction; runs: RecordedRun[] } {
  const runs: RecordedRun[] = []
  const launch: SpawnFunction = (command, args, options) => {
    const run: RecordedRun = { command, args: [...args], options, unrefed: false }
    runs.push(run)
    const listeners: Record<string, ((error?: Error) => void)[]> = {}
    const child: OpenedProcess & { emit: (event: string, error?: Error) => void } = {
      once(event, listener) {
        listeners[event] = [...(listeners[event] ?? []), listener]
        return undefined
      },
      unref() {
        run.unrefed = true
      },
      emit(event, error) {
        for (const listener of listeners[event] ?? []) listener(error)
      },
    }
    setImmediate(() => {
      if (outcome === 'error') {
        child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))
      } else {
        child.emit('spawn')
      }
    })
    return child
  }
  return { launch, runs }
}

describe('平台 → 命令', () => {
  it('macOS：打开是 open，显示是 open -R（选中那一个文件）', () => {
    expect(openCommandFor('darwin', 'open', '/Users/dev/out/report.pdf')).toEqual({
      command: 'open',
      args: ['/Users/dev/out/report.pdf'],
    })
    expect(openCommandFor('darwin', 'reveal', '/Users/dev/out/report.pdf')).toEqual({
      command: 'open',
      args: ['-R', '/Users/dev/out/report.pdf'],
    })
  })

  it('linux：两条都走 xdg-open，显示时打开的是目录', () => {
    // xdg-open 没有「选中这个文件」的语法，能给的只有「打开这个文件夹」。
    expect(openCommandFor('linux', 'open', '/home/dev/out/a.png')).toEqual({
      command: 'xdg-open',
      args: ['/home/dev/out/a.png'],
    })
    expect(openCommandFor('linux', 'reveal', '/home/dev/out/a.png')).toEqual({
      command: 'xdg-open',
      args: ['/home/dev/out'],
    })
  })

  it('windows：explorer，显示用 /select,', () => {
    expect(openCommandFor('win32', 'open', 'C:\\out\\a.png')).toEqual({
      command: 'explorer.exe',
      args: ['C:\\out\\a.png'],
    })
    expect(openCommandFor('win32', 'reveal', 'C:\\out\\a.png')).toEqual({
      command: 'explorer.exe',
      args: ['/select,C:\\out\\a.png'],
    })
  })

  it('不认识的平台 → 没有命令，而不是猜一条', () => {
    expect(openCommandFor('sunos', 'open', '/a')).toBeNull()
    expect(openCommandFor('sunos', 'reveal', '/a')).toBeNull()
    expect(createSystemOpener({ platform: 'sunos' })).toBeNull()
  })
})

describe('不经过 shell：文件名是一个独立的 argv 元素', () => {
  it('名字里带分号与反引号的文件也是个普通参数', async () => {
    const { launch, runs } = fakeSpawn()
    const opener = createSystemOpener({ platform: 'linux', spawn: launch })
    const nasty = '/home/dev/.abx/outbox/cell-1/report; rm -rf ~`.pdf'

    await opener?.openFile(nasty)

    expect(runs).toHaveLength(1)
    expect(runs[0]?.args).toEqual([nasty])
    // 没有拼接：argv 的每一项就是那条路径本身，一个字符都没多。
    expect(runs[0]?.args[0]).toBe(nasty)
  })

  it('shell 明确关掉，路径里有空格也不会被拆开', async () => {
    const { launch, runs } = fakeSpawn()
    const opener = createSystemOpener({ platform: 'darwin', spawn: launch })

    await opener?.openFile('/Users/dev/out/my report.pdf')
    await opener?.revealInFolder('/Users/dev/out/my report.pdf')

    expect(runs[0]?.options).toEqual({ shell: false, stdio: 'ignore', detached: true })
    expect(runs[0]?.args).toEqual(['/Users/dev/out/my report.pdf'])
    expect(runs[1]?.args).toEqual(['-R', '/Users/dev/out/my report.pdf'])
  })

  it('起来了就 unref：abx 退出之后看图的那个程序留着', async () => {
    const { launch, runs } = fakeSpawn()
    await createSystemOpener({ platform: 'linux', spawn: launch })?.openFile('/outbox/a.png')
    expect(runs[0]?.unrefed).toBe(true)
  })
})

describe('打开失败说得清楚', () => {
  it('宿主上没有那个命令 → 明说，并且指出文件已经在交付格里了', async () => {
    const { launch } = fakeSpawn('error')
    const opener = createSystemOpener({ platform: 'linux', spawn: launch })

    await expect(opener?.openFile('/outbox/a.png')).rejects.toThrow(OpenError)
    await expect(opener?.openFile('/outbox/a.png')).rejects.toThrow(/xdg-open/)
    await expect(opener?.openFile('/outbox/a.png')).rejects.toThrow(/交付格/)
  })

  it('相对路径直接拒——调用方本来就只该给交付格里的绝对路径', async () => {
    const { launch, runs } = fakeSpawn()
    const opener = createSystemOpener({ platform: 'linux', spawn: launch })

    await expect(opener?.openFile('report.pdf')).rejects.toThrow(/绝对路径/)
    expect(runs).toHaveLength(0)
  })
})
