import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOWS_PATH_EXTENSIONS, findCommandOnPath, isExecutableOnPath } from './host-command'
import type { PathLookup } from './host-command'
import { RUNNING_PLATFORM, RUNNING_VOCABULARY } from './test-support'

/**
 * 这份测试分两半，验的是两件不同的事：
 *
 *   - **前一半是纯的**：`PATH`、`PATHEXT`、以及「这个路径能不能执行」全都注入，
 *     所以能在 Linux 上把 win32 那条分支完整跑一遍。Windows 的扩展名逻辑
 *     （`docker` → `docker.exe`）只有这样才能验得到，而那正是原先漏掉的一环。
 *   - **后一半用真环境**：`isExecutableOnPath` 碰的是这台机器真实的 `PATH` 与文件系统，
 *     所以只能验跑测试的这台机器。
 */

interface FakeEntry {
  readonly directory: string
  readonly files: readonly string[]
}

/**
 * 一个假的宿主：只有列出来的那些文件存在。
 *
 * win32 那一份**按大小写不敏感判定**：真实的 Windows 文件系统就是这样，
 * 而 `PATHEXT` 里写的是大写的 `.EXE`、磁盘上常常是小写的 `docker.exe`——
 * 不折叠的话这个模拟会得出一个真机上不存在的结论（「装了 docker 但找不到」）。
 * POSIX 那一份按大小写敏感，同样是照真实行为来的。
 */
function fakeLookup(platform: PathLookup['platform'], entries: readonly FakeEntry[], extensions: readonly string[] = []): PathLookup {
  const fold = (value: string): string =>
    platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value
  const existing = new Set(entries.flatMap((entry) => entry.files.map((file) => `${fold(entry.directory)}|${fold(file)}`)))
  return {
    platform,
    searchDirs: entries.map((entry) => entry.directory),
    pathExtensions: extensions,
    isExecutable: (candidate) => {
      // win32 上正反斜杠都是分隔符（`C:/Windows/System32/cmd.exe` 在那边是合法写法），
      // POSIX 上只有正斜杠——照真实行为来。
      const cut = platform === 'win32' ? Math.max(candidate.lastIndexOf('\\'), candidate.lastIndexOf('/')) : candidate.lastIndexOf('/')
      if (cut <= 0) return false
      return existing.has(`${fold(candidate.slice(0, cut))}|${fold(candidate.slice(cut + 1))}`)
    },
  }
}

describe('findCommandOnPath · Windows：扩展名那一条路', () => {
  const entries: readonly FakeEntry[] = [
    { directory: 'C:\\Windows\\System32', files: ['cmd.exe', 'where.exe'] },
    { directory: 'C:\\Program Files\\Docker', files: ['docker.exe'] },
  ]

  it('PATH 里没有扩展名，磁盘上有——照样查得到', () => {
    // 这就是 Windows 上原先查不到 docker 的原因：拼出来的是
    // `C:\Program Files\Docker\docker`，而磁盘上叫 `docker.exe`。
    const lookup = fakeLookup('win32', entries, DEFAULT_WINDOWS_PATH_EXTENSIONS)
    expect(findCommandOnPath('docker', lookup)).toBe(true)
    expect(findCommandOnPath('cmd', lookup)).toBe(true)
  })

  it('不试扩展名就查不到——这条说明上一条不是碰巧过的', () => {
    // 反面对照：把 PATHEXT 抽掉，同一份假宿主上就一个都找不到。
    const bare = fakeLookup('win32', entries, [])
    expect(findCommandOnPath('docker', bare)).toBe(false)
  })

  it('扩展名按 PATHEXT 给的顺序试，不写死 .exe', () => {
    const store = fakeLookup('win32', [{ directory: 'C:\\tools', files: ['thing.bat'] }], ['.BAT'])
    expect(findCommandOnPath('thing', store)).toBe(true)
    // 只给 `.EXE` 的话同一个文件查不到——说明判的是传进来的那份名单。
    const exeOnly = fakeLookup('win32', [{ directory: 'C:\\tools', files: ['thing.bat'] }], ['.EXE'])
    expect(findCommandOnPath('thing', exeOnly)).toBe(false)
  })

  it('已经带扩展名也认（用户可能自己写全了）', () => {
    const lookup = fakeLookup('win32', entries, DEFAULT_WINDOWS_PATH_EXTENSIONS)
    expect(findCommandOnPath('docker.exe', lookup)).toBe(true)
  })

  it('绝对路径直接查，不走 PATH', () => {
    const lookup = fakeLookup('win32', entries, DEFAULT_WINDOWS_PATH_EXTENSIONS)
    expect(findCommandOnPath('C:\\Program Files\\Docker\\docker.exe', lookup)).toBe(true)
    // 反斜杠与正斜杠都算路径形态——`C:/Program Files/...` 在 Windows 上同样合法。
    expect(findCommandOnPath('C:/Windows/System32/cmd.exe', lookup)).toBe(true)
    expect(findCommandOnPath('D:\\nope\\thing.exe', lookup)).toBe(false)
  })

  it('命令不存在就是不存在', () => {
    const lookup = fakeLookup('win32', entries, DEFAULT_WINDOWS_PATH_EXTENSIONS)
    expect(findCommandOnPath('abx-definitely-not-a-command', lookup)).toBe(false)
  })

  it('win32：大小写不敏感——`.EXE` 与磁盘上的 `.exe` 是同一个文件', () => {
    // 这条是上一条能成立的前提：`PATHEXT` 里写的是大写，磁盘上常常是小写。
    const lookup = fakeLookup('win32', [{ directory: 'c:\\program files\\docker', files: ['DOCKER.EXE'] }], ['.EXE'])
    expect(findCommandOnPath('docker', lookup)).toBe(true)
  })

  it('PATH 里的空段不当成当前目录', () => {
    // 「当前目录恰好有个同名文件」是这类查找最经典的一种意外。这里问的是
    // 「docker 装好了没有」，不是「能不能执行当前目录里那个东西」。
    const lookup: PathLookup = {
      platform: 'win32',
      searchDirs: [''],
      pathExtensions: ['.EXE'],
      isExecutable: () => true,
    }
    expect(findCommandOnPath('docker', lookup)).toBe(false)
  })
})

describe('findCommandOnPath · POSIX：没有扩展名这回事', () => {
  const entries: readonly FakeEntry[] = [{ directory: '/usr/bin', files: ['sh', 'docker'] }]

  it('名字对得上就能查到', () => {
    expect(findCommandOnPath('sh', fakeLookup('linux', entries))).toBe(true)
  })

  it('不会去试扩展名——POSIX 上 `sh.exe` 是另一个文件，不是同一个', () => {
    const lookup = fakeLookup('linux', [{ directory: '/usr/bin', files: ['sh.exe'] }])
    expect(findCommandOnPath('sh', lookup)).toBe(false)
  })

  it('反斜杠不算路径分隔符：那一串被当成**文件名**，走 PATH 查找', () => {
    // 注入 linux 时 `C:\Windows\System32\cmd.exe` 不是一条路径，而是一个带反斜杠的
    // 命令名——在 POSIX 上这种名字是合法的文件名。所以它在 `/usr/bin` 下真有这么一个
    // 文件时是**查得到**的。这条钉的是「判定按注入的平台走」，不是「POSIX 也该认盘符」。
    const lookup = fakeLookup('linux', [{ directory: '/usr/bin', files: ['C:\\Windows\\System32\\cmd.exe'] }])
    expect(findCommandOnPath('C:\\Windows\\System32\\cmd.exe', lookup)).toBe(true)
    // 而它绝不会被当成「绝对路径」去直接查——`/usr/bin/sh` 走的是直接查那一条。
    expect(findCommandOnPath('/usr/bin/sh', fakeLookup('linux', entries))).toBe(true)
    expect(findCommandOnPath('/usr/bin', fakeLookup('linux', entries))).toBe(false)
  })

  it('大小写敏感：`SH` 与 `sh` 是两个文件', () => {
    const lookup = fakeLookup('linux', [{ directory: '/usr/bin', files: ['sh'] }])
    expect(findCommandOnPath('SH', lookup)).toBe(false)
    expect(findCommandOnPath('sh', lookup)).toBe(true)
  })

  it('PATH 里的空段同样不当成当前目录', () => {
    const lookup: PathLookup = {
      platform: 'linux',
      searchDirs: [''],
      pathExtensions: [],
      isExecutable: () => true,
    }
    expect(findCommandOnPath('sh', lookup)).toBe(false)
  })
})

describe('isExecutableOnPath · 这台机器真实的环境', () => {
  it('绝对路径：存在且可执行就 true，不存在就 false', () => {
    // 分平台取一个**这台机器上一定有**的可执行文件。`/bin/sh` 只在 POSIX 上有；
    // Windows 上没有 `/bin`，那边用当前这个 node 自己。
    const known = RUNNING_PLATFORM === 'win32' ? process.execPath : '/bin/sh'
    expect(isExecutableOnPath(known, RUNNING_PLATFORM)).toBe(true)

    const missing = RUNNING_VOCABULARY.join(RUNNING_VOCABULARY.fsRoot, 'abx-definitely', 'not', 'here')
    expect(isExecutableOnPath(missing, RUNNING_PLATFORM)).toBe(false)
  })

  it('PATH 上的命令能查到', () => {
    // Windows 上换成 `cmd`：它**不带扩展名**也查得到，顺带把 PATHEXT 那条路
    // 在真机上验了一遍（Linux 上验的是「不试扩展名」那一半）。
    const command = RUNNING_PLATFORM === 'win32' ? 'cmd' : 'sh'
    expect(isExecutableOnPath(command, RUNNING_PLATFORM)).toBe(true)
  })

  it('不存在的命令查不到', () => {
    expect(isExecutableOnPath('abx-definitely-not-a-command', RUNNING_PLATFORM)).toBe(false)
  })
})
