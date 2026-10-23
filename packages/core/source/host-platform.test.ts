import { describe, expect, it } from 'vitest'
import { HOST_PLATFORMS, hostPathRulesFor, parseHostPlatform } from './host-platform'
import type { HostPlatform } from './host-platform'

/**
 * 这份测试是**开发机上唯一能验 Windows 规则的地方**：跑在 Linux 上，判的是 win32 那套。
 *
 * 所以这里只做**纯字符串判定**（禁挂前缀、UNC、盘符、让路），一个文件系统调用都没有——
 * 一旦碰磁盘，判的就是跑测试的这台机器，验不了别的平台。碰磁盘的那部分在
 * `session/mount-policy.test.ts` 里，那里的夹具跟着**当前**平台走。
 */

const WIN_HOME = 'C:\\Users\\dev'
const POSIX_HOME = '/home/dev'

describe('parseHostPlatform', () => {
  it('认得清单里那三个平台', () => {
    expect(HOST_PLATFORMS).toEqual(['darwin', 'linux', 'win32'])
    for (const platform of HOST_PLATFORMS) {
      expect(parseHostPlatform(platform)).toBe(platform)
    }
  })

  it('Node 认得、但这套隔离没有写规则的平台一律认不出', () => {
    // `process.platform` 的类型里有这些值，所以「认不出」不是假想的输入。
    for (const value of ['freebsd', 'aix', 'openbsd', 'sunos', 'android', 'cygwin']) {
      expect(parseHostPlatform(value)).toBeNull()
    }
  })

  it('不是字符串的一律认不出', () => {
    for (const value of [undefined, null, 42, {}, ['linux']]) {
      expect(parseHostPlatform(value)).toBeNull()
    }
  })

  it('大小写与空白不宽容，也不做 trim：认不出就是认不出', () => {
    expect(parseHostPlatform('Win32')).toBeNull()
    expect(parseHostPlatform(' win32')).toBeNull()
    expect(parseHostPlatform('')).toBeNull()
  })
})

describe('hostPathRulesFor', () => {
  it('三个平台都拿得到规则，且 platform 就是问的那一个', () => {
    for (const platform of HOST_PLATFORMS) {
      expect(hostPathRulesFor(platform).platform).toBe(platform)
    }
  })

  it('不认识的平台抛错，而不是退到某一份规则上', () => {
    // 退回任何一份规则都意味着「认不出平台」这件事变成了「按某个平台的规矩放行」。
    // 那正是这个函数要避免的：`freebsd` 上应该什么都不放行。
    expect(() => hostPathRulesFor('freebsd' as HostPlatform)).toThrowError(/不认识的宿主平台/)
  })

  it('报错里有这个值本身和认识的名单，用户能照着改', () => {
    expect(() => hostPathRulesFor('aix' as HostPlatform)).toThrowError(/"aix"/)
    expect(() => hostPathRulesFor('aix' as HostPlatform)).toThrowError(/darwin \/ linux \/ win32/)
  })

  it('路径语义：POSIX 平台用 posix，win32 用 win32', () => {
    expect(hostPathRulesFor('linux').path.sep).toBe('/')
    expect(hostPathRulesFor('darwin').path.sep).toBe('/')
    expect(hostPathRulesFor('win32').path.sep).toBe('\\')
  })

  it('同一个字符串在不同平台上拼出不同的路径——这就是必须分平台的原因', () => {
    // 这条是 `\home\node\.claude` 那个 bug 的最小形态：舱内路径 `/home/node/.claude`
    // 一旦用宿主的 path 去拼，Windows 上就变成 `\home\node\.claude`。
    expect(hostPathRulesFor('linux').path.join('/home', 'node', '.claude')).toBe('/home/node/.claude')
    expect(hostPathRulesFor('win32').path.join('/home', 'node', '.claude')).toBe('\\home\\node\\.claude')
  })

  it('绝对性判定也按平台走', () => {
    expect(hostPathRulesFor('win32').path.isAbsolute('C:\\Users\\dev')).toBe(true)
    expect(hostPathRulesFor('linux').path.isAbsolute('C:\\Users\\dev')).toBe(false)
  })

  it('`isAbsolute` 拦不住 POSIX 写法的路径：win32 认为它是「当前盘根下」的', () => {
    // `/home/dev` 在 win32 眼里是绝对的（`\home\dev`，盘符取当前盘），所以
    // 「用 isAbsolute 把非法路径挡在外面」这个想法在 Windows 上不成立——
    // 它只会让路径悄悄落到某个盘上。真正要挡靠的是分平台的规则。
    expect(hostPathRulesFor('win32').path.isAbsolute('/home/dev')).toBe(true)
    expect(hostPathRulesFor('linux').path.isAbsolute('/home/dev')).toBe(true)
  })
})

describe('win32 的禁挂判定', () => {
  const rules = hostPathRulesFor('win32')

  it('系统盘下的保留目录一条都不放，盘符不写死', () => {
    for (const source of [
      'C:\\Windows',
      'C:\\Windows\\System32',
      'C:\\Program Files',
      'C:\\Program Files (x86)\\app',
      'C:\\ProgramData',
      'C:\\Users',
      'C:\\Users\\dev',
      'C:\\Users\\dev\\.ssh',
      'D:\\Windows',
      'E:\\Program Files',
    ]) {
      expect(rules.matchForbiddenMountSource(source), source).not.toBeNull()
    }
  })

  it('大小写不敏感：换个大小写绕不过去', () => {
    // Windows 的文件系统大小写不敏感，`c:\windows` 就是 `C:\Windows`。
    expect(rules.matchForbiddenMountSource('c:\\windows')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('C:\\WINDOWS')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('c:\\uSeRs\\dev')).not.toBeNull()
  })

  it('正斜杠与末尾分隔符也归一：换个写法绕不过去', () => {
    expect(rules.matchForbiddenMountSource('C:/Windows')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('C:/Windows/System32')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('C:\\Windows\\')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('C:\\')).not.toBeNull()
    expect(rules.matchForbiddenMountSource('C:')).not.toBeNull()
  })

  it('UNC 与设备路径一律拒', () => {
    for (const source of [
      '\\\\server\\share',
      '\\\\server\\share\\project',
      '\\\\?\\C:\\Windows',
      '\\\\.\\pipe\\docker_engine',
      '\\\\.\\C:\\',
    ]) {
      expect(rules.matchForbiddenMountSource(source), source).not.toBeNull()
    }
  })

  it('docker 命名管道单独点名——它是最容易被顺手挂进去的一个', () => {
    expect(rules.matchForbiddenMountSource('\\\\.\\pipe\\docker_engine')).toBe('\\\\.\\pipe\\docker_engine')
  })

  it('正常项目目录放行', () => {
    for (const source of ['D:\\projects\\thing', 'C:\\dev\\thing', 'E:\\work\\repo', 'C:\\abx\\instances\\x']) {
      expect(rules.matchForbiddenMountSource(source), source).toBeNull()
    }
  })

  it('前缀边界：`C:\\WindowsApps` 不算 `C:\\Windows` 下面', () => {
    // 名单里是目录名整段，不是字符串前缀——`C:\WindowsApps` 是另一个目录。
    expect(rules.matchForbiddenMountSource('C:\\WindowsApps\\thing')).toBeNull()
    expect(rules.matchForbiddenMountSource('C:\\Program Files Extra\\thing')).toBeNull()
  })

  it('POSIX 的名单在 win32 上一条都不生效——这正是原先那个 bug', () => {
    // 之前禁挂名单写的是 `/home`、`/etc`，而 Windows 上的路径是 `C:\Users\...`，
    // 一个都对不上，「主目录不许挂」这条闸门于是静默失效。这条测试钉住的是
    // 「win32 现在有自己的规则」，不是「`/home` 应该被拒」。
    expect(rules.matchForbiddenMountSource('/home/dev')).toBeNull()
    expect(rules.matchForbiddenMountSource('/etc/passwd')).toBeNull()
  })
})

describe('linux / darwin 的禁挂判定', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}：POSIX 前缀照旧`, () => {
      const rules = hostPathRulesFor(platform)
      for (const source of ['/home/dev', '/home', '/root/.ssh', '/etc/passwd', '/var/run', '/proc/self', '/dev/sda']) {
        expect(rules.matchForbiddenMountSource(source), source).not.toBeNull()
      }
      expect(rules.matchForbiddenMountSource('/srv/data')).toBeNull()
      expect(rules.matchForbiddenMountSource('/workspace')).toBeNull()
    })

    it(`${platform}：docker socket 单独点名`, () => {
      expect(hostPathRulesFor(platform).matchForbiddenMountSource('/var/run/docker.sock')).toBe('/var/run/docker.sock')
    })

    it(`${platform}：前缀边界——\`/homely\` 不在 \`/home\` 下面`, () => {
      expect(hostPathRulesFor(platform).matchForbiddenMountSource('/homely')).toBeNull()
      expect(hostPathRulesFor(platform).matchForbiddenMountSource('/etcetera')).toBeNull()
    })

    it(`${platform}：Windows 的路径在这里不算绝对路径，也就谈不上禁`, () => {
      expect(hostPathRulesFor(platform).matchForbiddenMountSource('C:\\Windows')).toBeNull()
    })
  }
})

describe('实例根的禁挂判定（唯一一处「让路」）', () => {
  it('POSIX：默认实例根在主目录下面，罩住 home 的前缀让路', () => {
    const rules = hostPathRulesFor('linux')
    expect(rules.instanceRootViolation('/home/dev/.abx/instances', POSIX_HOME)).toBeNull()
  })

  it('POSIX：让路只让罩住 home 的那一条，别的照旧不放', () => {
    const rules = hostPathRulesFor('linux')
    expect(rules.instanceRootViolation('/etc/instances', POSIX_HOME)).toContain('禁挂前缀')
    expect(rules.instanceRootViolation('/var/run/instances', POSIX_HOME)).toContain('禁挂前缀')
    expect(rules.instanceRootViolation('/root/instances', POSIX_HOME)).toContain('禁挂前缀')
  })

  it('win32：默认实例根在主目录下面，同样让路——判据按形状，不按盘符', () => {
    const rules = hostPathRulesFor('win32')
    expect(rules.instanceRootViolation('C:\\Users\\dev\\.abx\\instances', WIN_HOME)).toBeNull()
    // 系统盘不是 C: 的机器上，同一个形状照样让路。写死 `C:\Users` 的名单在这里会误杀。
    expect(rules.instanceRootViolation('D:\\Users\\dev\\.abx\\instances', 'D:\\Users\\dev')).toBeNull()
  })

  it('win32：让路只让罩住 home 的那一条', () => {
    const rules = hostPathRulesFor('win32')
    expect(rules.instanceRootViolation('D:\\Windows\\instances', WIN_HOME)).toContain('D:\\Windows')
    expect(rules.instanceRootViolation('C:\\ProgramData\\instances', WIN_HOME)).not.toBeNull()
    // 盘根罩得住任何人，但它自己不是 home，所以照旧拒。
    expect(rules.instanceRootViolation('C:\\', WIN_HOME)).not.toBeNull()
  })

  it('win32：UNC 没有「前缀」这回事，所以无路可让', () => {
    const rules = hostPathRulesFor('win32')
    expect(rules.instanceRootViolation('\\\\server\\share\\instances', WIN_HOME)).not.toBeNull()
  })

  it('win32：home 就在被点名的那一层时也让路，但只让那一层', () => {
    const rules = hostPathRulesFor('win32')
    // home 恰好是 `C:\Users`（少见但合法）——那时 `C:\Users` 这条规则罩住它。
    expect(rules.instanceRootViolation('C:\\Users\\.abx\\instances', 'C:\\Users')).toBeNull()
    // 而 `C:\Windows` 与被让路的规则无关，照旧拒。
    expect(rules.instanceRootViolation('C:\\Windows\\instances', 'C:\\Users')).not.toBeNull()
  })
})

describe('危险根判定', () => {
  it('POSIX：文件系统根与系统目录不许当任务目录', () => {
    const rules = hostPathRulesFor('linux')
    for (const candidate of ['/', '/home', '/etc', '/usr', '/var']) {
      expect(rules.isDangerousRoot(candidate), candidate).toBe(true)
    }
    expect(rules.isDangerousRoot('/home/dev/project')).toBe(false)
  })

  it('win32：盘根与保留目录不许当任务目录，普通项目目录可以', () => {
    const rules = hostPathRulesFor('win32')
    for (const candidate of ['C:\\', 'D:\\', 'C:\\Windows', 'C:\\Users', '\\\\server\\share']) {
      expect(rules.isDangerousRoot(candidate), candidate).toBe(true)
    }
    expect(rules.isDangerousRoot('C:\\dev\\project')).toBe(false)
    expect(rules.isDangerousRoot('D:\\projects\\thing')).toBe(false)
  })
})
