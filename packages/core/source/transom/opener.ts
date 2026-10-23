/**
 * 「打开」这个动作本身。
 *
 * 这是传递窗唯一一处**在宿主上引起副作用**的地方，所以它有三条硬规矩：
 *
 *   1. **不经过 shell。** 命令与参数是一份 argv **数组**交给 `spawn(shell: false)`，
 *      文件名永远不会被拼进一条命令字符串里。拼字符串的话，一个叫
 *      `report; rm -rf ~.pdf` 的文件——名字完全合法、而且可以来自舱内——就成了一条命令。
 *      这一条不是「小心一点」就能守住的，所以它是结构上不可发生的：这个文件里
 *      没有任何一处把路径塞进字符串。
 *   2. **只打开交付格里的东西。** 调用方只能给「刚递出来的那份」的路径（见
 *      `service.ts`：工具收的是一个**文件名**，不是路径，路径由交付格拼出来）。
 *      这里不做第二道路径闸，因为多一道看起来更安全的检查会让人以为「随便给条路径
 *      也没事」——真正的闸在上一层的形状上。
 *   3. **要不要打开是上层决定的**（白名单，见 `transom.ts` 的 `classifyDeliverable`）。
 *      这一层不认识文件类型，它只负责把已经决定要打开的那个打开。
 *
 * **可注入**是有意的，而且是验收要求的一部分：真实实现会弹出窗口，跑测试时不能弹。
 * `Opener` 是个接口，用例给一个记账用的替身。
 */

import { spawn } from 'node:child_process'

export class OpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenError'
  }
}

/**
 * 打开一个文件，或者只是在文件夹里指出它。
 *
 * `revealInFolder` 是**降级路径**，也是白名单之外所有东西的落点：屏幕上出现一个
 * 文件夹、里面那一个文件被选中，但没有任何东西被执行。它必须永远可用——
 * 「打开不了」不等于「这东西给不了你」。
 */
export interface Opener {
  /** 用哪个命令打开的。进审计，出问题时能一眼看出是 `open` 还是 `xdg-open`。 */
  readonly name: string
  openFile(absolutePath: string): Promise<void>
  revealInFolder(absolutePath: string): Promise<void>
}

/** 一次要跑的命令。argv 数组，不是一个字符串。 */
export interface OpenCommand {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * 平台 → 两条命令。**纯函数**，所以「macOS 上是 `open -R`」这种事有测试守着。
 *
 * 返回 `null` 表示这个平台不知道怎么打开文件。这时交付照样成功，只是不会有人替
 * 用户打开它——说得出「这个平台不支持」比猜一条命令、然后失败得莫名其妙要好。
 */
export function openCommandFor(platform: string, kind: 'open' | 'reveal', absolutePath: string): OpenCommand | null {
  if (platform === 'darwin') {
    return kind === 'open'
      ? { command: 'open', args: [absolutePath] }
      : { command: 'open', args: ['-R', absolutePath] }
  }
  if (platform === 'win32') {
    // `explorer` 的选中语法就是 `/select,<路径>` 写成**一个**参数。没在 Windows 上
    // 实测过（开发机是 linux），所以这一条是照文档写的——它属于「未验证项」。
    return kind === 'open'
      ? { command: 'explorer.exe', args: [absolutePath] }
      : { command: 'explorer.exe', args: [`/select,${absolutePath}`] }
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    // xdg-open 没有「选中这个文件」的语法，只能把**目录**打开。这仍然是降级：
    // 屏幕上是那个文件夹，不是被执行的文件。
    return kind === 'open'
      ? { command: 'xdg-open', args: [absolutePath] }
      : { command: 'xdg-open', args: [dirnameOf(absolutePath)] }
  }
  return null
}

/** 起进程时用的那几个选项。收窄成一份接口，是为了让测试能换掉 `spawn`。 */
export interface OpenSpawnOptions {
  readonly shell: boolean
  readonly stdio: 'ignore'
  readonly detached: boolean
}

/** 起出来的那个进程：这一层只用到「等它起来」「别管它」两件事。 */
export interface OpenedProcess {
  once(event: string, listener: (error?: Error) => void): unknown
  unref(): void
}

export type SpawnFunction = (command: string, args: readonly string[], options: OpenSpawnOptions) => OpenedProcess

/**
 * 真的去开。`spawn` 可以被换掉，只为测试——用例要断言的是「跑了什么 argv」，
 * 而不是「窗口弹出来了没有」（跑测试时弹窗是灾难）。
 */
export interface SystemOpenerOptions {
  readonly platform?: string
  readonly spawn?: SpawnFunction
}

export function createSystemOpener(options: SystemOpenerOptions = {}): Opener | null {
  const platform = options.platform ?? process.platform
  const launch: SpawnFunction = options.spawn ?? spawn
  // 用同一个映射表探一下这个平台认不认：不认就返回 `null`，让上层记一句
  // 「这个平台不知道怎么打开」而不是猜一条命令然后失败得莫名其妙。
  if (openCommandFor(platform, 'open', '/') === null) return null

  return {
    name: platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open',
    openFile: (absolutePath) => run(launch, platform, 'open', absolutePath),
    revealInFolder: (absolutePath) => run(launch, platform, 'reveal', absolutePath),
  }
}

async function run(launch: SpawnFunction, platform: string, kind: 'open' | 'reveal', absolutePath: string): Promise<void> {
  if (!absolutePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(absolutePath)) {
    throw new OpenError(`只打开绝对路径，收到的是 ${JSON.stringify(absolutePath)}。`)
  }
  const command = openCommandFor(platform, kind, absolutePath)
  if (command === null) {
    throw new OpenError(`这个平台（${platform}）上不知道怎么打开文件。`)
  }

  const child = launch(command.command, [...command.args], {
    // 三个都是要害：`shell: false` 让上面那条「不经过 shell」的承诺成立；
    // `stdio: 'ignore'` 免得被打开的程序抓住我们的管道；
    // `detached` + `unref()` 让 abx 自己可以退出去，而看图/看 PDF 的那个程序留着。
    shell: false,
    stdio: 'ignore',
    detached: true,
  })

  try {
    // `spawn` 事件只有真的起来了才会有；命令不存在时来的是 `error`。
    // 不等这一下的话，「xdg-open 没装」会被悄悄咽掉，而用户那边什么都没发生。
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => reject(error ?? new Error('起进程失败')))
    })
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    throw new OpenError(
      code === 'ENOENT'
        ? `宿主上找不到 ${command.command}：这台机器上没有「打开文件」的命令，文件已经递到交付格里了，自己去看。`
        : `调用 ${command.command} 失败：${error instanceof Error ? error.message : String(error)}。`,
    )
  }
  child.unref()
}

/** 只为了 `xdg-open` 那条降级路径。posix 与 windows 两种分隔符都认。 */
function dirnameOf(absolutePath: string): string {
  const index = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'))
  return index <= 0 ? absolutePath : absolutePath.slice(0, index)
}
