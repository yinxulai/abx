import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALL_VOCABULARIES, RUNNING_PLATFORM, RUNNING_RULES, RUNNING_VOCABULARY } from '../test-support'
import type { SandboxConfigFile, SandboxMount, SandboxStateDir } from './backend'
import { INSTANCES_ROOT_ENV, defaultInstancesRoot } from './instance'
import {
  FORBIDDEN_CREDENTIAL_FILE_PATTERNS,
  FORBIDDEN_INSTANCE_ROOT_SUBDIRS,
  MOUNT_POLICY,
  MountPolicyViolation,
  assertInstancesRoot,
  assertMountPolicy,
  assertStateDirPolicy,
  findRiskyFilesInTaskDir,
  isForbiddenMountSource,
  matchCredentialFileRule,
} from './mount-policy'

/*
 * 宿主路径**全部**出自 `HOST`（跑测试这台机器的词汇表），一个都不写死。
 *
 * 理由不是洁癖：写死 `/home/dev/projects/thing` 的用例在 Linux 上判的是
 * 「在 `/home` 下面」，在 Windows 上判的是「当前盘根下的 `home\dev\...`」——
 * 后者一条规则都命中不了，于是同一条断言在两边得出不同结论，而**两边都"跑过了"**。
 * 舱内路径（`WORKDIR`、`CELL_HOME`、挂载目标）相反：那些永远是 POSIX，写死才对，
 * 见 `cell-path.ts`。
 */

const HOST = RUNNING_VOCABULARY
const RULES = RUNNING_RULES
const isWindows = RUNNING_PLATFORM === 'win32'

/** 舱内工作目录。永远是 POSIX——容器里的路径跟宿主是什么系统无关。 */
const WORKDIR = '/workspace'
/** 舱内 home。同上。 */
const CELL_HOME = '/home/node'
const TASK_DIR = HOST.taskDir

/**
 * 「所有用户的家」那一层。
 *
 * POSIX 上是 `/root`（别人的 home），Windows 上是 `C:\Users`（`C:\Users\dev` 的
 * 上一级）。两个平台上它都是禁挂名单里的一条，而具体是哪一条跟着平台走。
 */
const OTHERS_HOMES = isWindows ? RULES.path.dirname(HOST.home) : '/root'

/** 在宿主路径里插一段 `..`。用字符串拼而不是 `path.join`——后者会把 `..` 折叠掉，那样就什么都没测到。 */
function withParentSegment(base: string): string {
  return `${base}${RULES.path.sep}..${RULES.path.sep}elsewhere`
}

function assert(mounts: readonly SandboxMount[], taskDir = TASK_DIR): void {
  assertMountPolicy({ platform: RUNNING_PLATFORM, mounts, taskDir, workdir: WORKDIR })
}

describe('MOUNT_POLICY.buildMounts', () => {
  it('只产出任务目录这一个挂载点', () => {
    expect(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR)).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
    ])
  })

  it('任务目录可写——agent 要在里面干活', () => {
    expect(MOUNT_POLICY.taskDirMode).toBe('rw')
    expect(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR)[0]?.mode).toBe('rw')
  })

  it('相对路径被解析成绝对路径', () => {
    const [mount] = MOUNT_POLICY.buildMounts('some/relative', WORKDIR)
    // 判据是**这个平台的绝对路径**，不是「以 `/` 开头」——Windows 上是 `C:\...`。
    expect(RULES.path.isAbsolute(mount?.source ?? '')).toBe(true)
  })

  it('生成的配置逐个只读挂进来，任务目录仍是唯一的可写挂载', () => {
    const hostPath = HOST.underHome('.abx', 'cells', 'c1', 'agents', 'claude', 'settings.json')
    const cellPath = '/home/dev/.claude/settings.json'
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [{ hostPath, cellPath }])
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: hostPath, target: cellPath, mode: 'ro' },
    ])
  })

  it('不传就是老样子：只有任务目录', () => {
    expect(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR)).toHaveLength(1)
  })

  it('策略对象自带说明，读代码的人不用去别处找理由', () => {
    expect(MOUNT_POLICY.summary).toContain('任务目录')
    expect(MOUNT_POLICY.mountsHostHome).toBe(false)
    expect(MOUNT_POLICY.rules.length).toBeGreaterThanOrEqual(4)
    for (const rule of MOUNT_POLICY.rules) {
      expect(rule.requirement.length).toBeGreaterThan(0)
      expect(rule.rationale.length).toBeGreaterThan(0)
    }
  })

  it('可写的就两类，而且状态目录必须 rw——只读的话历史一行都落不下来', () => {
    expect([...MOUNT_POLICY.writableClasses]).toEqual(['taskDir', 'instanceState'])
    expect(MOUNT_POLICY.taskDirMode).toBe('rw')
    expect(MOUNT_POLICY.stateDirMode).toBe('rw')
  })

  it('实例状态目录排在配置文件前面挂，而且是目录形态的 rw', () => {
    const hostPath = HOST.underHome('.abx', 'instances', 'claude', 'claude')
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [
      { hostPath, cellPath: `${CELL_HOME}/.claude`, agentId: 'claude' },
    ])
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: hostPath, target: `${CELL_HOME}/.claude`, mode: 'rw' },
    ])
  })
})

/*
 * 这一组是**纯字符串**判定，所以三个平台各跑一遍——在 Linux 上就能把 win32 那一套
 * 完整验掉。碰真实文件系统的那些组只能用跑测试这台机器，见文件开头的说明。
 */
describe('isForbiddenMountSource', () => {
  it('主目录、系统目录、docker 端点，三个平台上都算禁挂', () => {
    for (const host of ALL_VOCABULARIES) {
      const sources = [
        host.home,
        host.underHome('.ssh'),
        host.underHome('.aws', 'credentials'),
        host.systemDir,
        host.join(host.systemDir, 'System32'),
        host.rules.dockerSocketPath,
        // 默认实例根与它下面那一格：它是可写挂载源，所以「禁挂前缀罩住 home」那条
        // 规则必须为它让路——**但 `isForbiddenMountSource` 是另一件事**，它问的是
        // 「这个路径能不能当挂载源」，答案是不能（任务目录才是豁免的那一类）。
        host.underHome('.abx', 'instances', 'claude', 'claude'),
      ]
      for (const source of sources) {
        expect(isForbiddenMountSource(source, host.platform), `${host.platform} ${source}`).toBe(true)
      }
    }
  })

  it('主目录下面的普通项目目录也在禁挂前缀里', () => {
    for (const host of ALL_VOCABULARIES) {
      expect(isForbiddenMountSource(host.taskDir, host.platform), host.platform).toBe(true)
    }
  })

  it('凭据文件即使在安全目录下也算禁挂', () => {
    for (const host of ALL_VOCABULARIES) {
      for (const name of ['.env', 'server.pem', 'auth.json', 'id_rsa']) {
        const source = host.join(host.outsideDir, name)
        expect(isForbiddenMountSource(source, host.platform), `${host.platform} ${source}`).toBe(true)
      }
    }
  })

  it('普通目录不禁', () => {
    for (const host of ALL_VOCABULARIES) {
      for (const source of [host.outsideDir, host.join(host.outsideDir, 'work'), host.join(host.outsideDir, 'settings.json')]) {
        expect(isForbiddenMountSource(source, host.platform), `${host.platform} ${source}`).toBe(false)
      }
    }
  })

  it('前缀相似但不同级的路径不会误判', () => {
    // 判的是「目录名整段」，不是字符串前缀。每个平台各取一个「长得像但不是」的例子：
    // POSIX 上 `/homely` 不在 `/home` 下面，Windows 上 `C:\WindowsApps` 不在
    // `C:\Windows` 下面。
    const nearMisses: Readonly<Record<string, readonly string[]>> = {
      linux: ['/homely/data', '/etcetera/data', '/var/runner/data'],
      darwin: ['/homely/data', '/etcetera/data', '/var/runner/data'],
      win32: ['C:\\WindowsApps\\thing', 'C:\\Program Files Extra\\thing', 'D:\\Users2\\thing'],
    }
    for (const host of ALL_VOCABULARIES) {
      for (const source of nearMisses[host.platform] ?? []) {
        expect(isForbiddenMountSource(source, host.platform), `${host.platform} ${source}`).toBe(false)
      }
    }
  })
})

describe('凭据文件名黑名单', () => {
  it('登记的全是「看上去像文件」的规则，不是目录', () => {
    expect([...FORBIDDEN_CREDENTIAL_FILE_PATTERNS]).toEqual(['.credentials.json', 'auth.json', '*.env', '*.pem', 'id_rsa*'])
  })

  it('三家 client 的同目录凭据文件都命中', () => {
    // 这几条就是「为什么不能挂 ~/.claude 整个目录」的全部理由。
    expect(matchCredentialFileRule('/home/dev/.claude/.credentials.json')).toBe('.credentials.json')
    expect(matchCredentialFileRule('/home/dev/.codex/auth.json')).toBe('auth.json')
    expect(matchCredentialFileRule('/home/dev/.pi/agent/auth.json')).toBe('auth.json')
  })

  it('两种分隔符都认：这个判定只按文件名，跟宿主是哪个平台无关', () => {
    // 挂载源是拖进来的，来源平台不一定跟宿主一样；而 `path.basename` 在 Windows 上
    // 本来就两种分隔符都切，所以这里不该分平台——同一个字符串在两边得出同一个结论。
    expect(matchCredentialFileRule('C:\\Users\\dev\\.claude\\.credentials.json')).toBe('.credentials.json')
    expect(matchCredentialFileRule('C:\\Users\\dev\\.ssh\\id_rsa')).toBe('id_rsa*')
    expect(matchCredentialFileRule('C:\\srv\\prod.env')).toBe('*.env')
  })

  it('*.env / *.pem / id_rsa* 命中，裸文件名也算', () => {
    expect(matchCredentialFileRule('/srv/.env')).toBe('*.env')
    expect(matchCredentialFileRule('/srv/prod.env')).toBe('*.env')
    expect(matchCredentialFileRule('/srv/tls.pem')).toBe('*.pem')
    expect(matchCredentialFileRule('/home/dev/.ssh/id_rsa')).toBe('id_rsa*')
    expect(matchCredentialFileRule('/home/dev/.ssh/id_rsa.pub')).toBe('id_rsa*')
  })

  it('大小写不敏感——macOS 的默认文件系统就是大小写不敏感的', () => {
    expect(matchCredentialFileRule('/home/dev/.claude/.CREDENTIALS.JSON')).toBe('.credentials.json')
  })

  it('只看文件名，前缀相似的不误判', () => {
    expect(matchCredentialFileRule('/home/dev/author.json')).toBeNull()
    expect(matchCredentialFileRule('/home/dev/my-auth.json')).toBeNull()
    expect(matchCredentialFileRule('/srv/envelope')).toBeNull()
  })

  it('配置文件本身不在黑名单里', () => {
    expect(matchCredentialFileRule('~/.claude/settings.json')).toBeNull()
    expect(matchCredentialFileRule('/home/dev/.codex/config.toml')).toBeNull()
    expect(matchCredentialFileRule('/home/dev/.dsh/settings.yaml')).toBeNull()
    expect(matchCredentialFileRule('C:\\Users\\dev\\.claude\\settings.json')).toBeNull()
  })
})

describe('assertMountPolicy', () => {
  it('正常的任务目录挂载通过', () => {
    expect(() => assert([{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }])).not.toThrow()
  })

  it('拒绝挂载用户主目录', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: HOST.home, target: '/home/dev', mode: 'ro' },
      ]),
    ).toThrow(MountPolicyViolation)
  })

  it('拒绝挂载 docker 端点', () => {
    // 来源跟着平台走：POSIX 上是一个 socket 文件，Windows 上是一个命名管道。
    // 挂载目标永远是舱内的 POSIX 路径，所以那里写的是同一个字符串。
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: RULES.dockerSocketPath, target: '/var/run/docker.sock', mode: 'rw' },
      ]),
    ).toThrow(/docker 端点/)
  })

  it('拒绝挂载 SSH 目录', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: HOST.underHome('.ssh'), target: '/root/.ssh', mode: 'ro' },
      ]),
    ).toThrow(/宿主路径一律不进舱内/)
  })

  it('拒绝挂载凭据文件，且说清它是凭据而不是一句笼统的「禁止路径」', () => {
    // 这条消息要说得出「为什么」：那个路径看上去跟配置文件毫无区别，
    // 只报「禁止路径」的话，用户只会去找一个更宽的挂载方式。
    const credential = HOST.underHome('.claude', '.credentials.json')
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: credential, target: '/home/dev/.claude/.credentials.json', mode: 'ro' },
      ]),
    ).toThrow(/凭据文件/)
  })

  it('同目录的凭据文件被拒，同目录的配置文件不受影响', () => {
    const directory = HOST.underHome('.claude')
    const credential = HOST.join(directory, 'auth.json')
    expect(() =>
      assert([{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, { source: credential, target: '/home/dev/.claude/auth.json', mode: 'ro' }]),
    ).toThrow(/凭据文件/)

    // 只差一个文件名。前缀规则区分不了这两者，所以凭据那条必须按文件名判——
    // （配置文件怎么合法地挂进来见 docker_backend 的用例。）
    expect(matchCredentialFileRule(HOST.join(directory, 'settings.json'))).toBeNull()
  })

  it('拒绝两个可写挂载', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: HOST.join(HOST.outsideDir, 'other'), target: '/srv/other', mode: 'rw' },
      ]),
    ).toThrow(MountPolicyViolation)
  })

  it('拒绝任务目录之外的任何挂载源，哪怕是只读的', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: HOST.outsideDir, target: '/srv/data', mode: 'ro' },
      ]),
    ).toThrow(/不允许有别的挂载源/)
  })

  it('拒绝挂在非工作目录的位置', () => {
    expect(() => assert([{ source: TASK_DIR, target: '/elsewhere', mode: 'rw' }])).toThrow(/不允许有别的挂载点/)
  })

  it('拒绝相对路径', () => {
    expect(() => assert([{ source: 'relative/path', target: WORKDIR, mode: 'rw' }])).toThrow(/绝对路径/)
  })

  it('拒绝路径里带 ..', () => {
    // `..` 能把一个看起来人畜无害的路径变成主目录。用字符串拼，别让 `path.join`
    // 把 `..` 折叠掉——折叠了这条用例就什么都没验到。
    expect(() => assert([{ source: withParentSegment(HOST.outsideDir), target: WORKDIR, mode: 'rw' }])).toThrow(
      /不允许出现 \.\./,
    )
  })

  it('正斜杠写的 .. 也拦得住——Windows 上 `/` 同样是分隔符', () => {
    // 只按 `rules.path.sep` 切的话，Windows 上 `C:/Users/../Windows` 会被当成一个
    // 普通名字，这道闸门于是**静默失效**。这一条钉的就是那个口子。
    const slashed = HOST.home.replaceAll(RULES.path.sep, '/')
    expect(() => assert([{ source: `${slashed}/../elsewhere`, target: WORKDIR, mode: 'rw' }])).toThrow(/不允许出现 \.\./)
  })

  it('拒绝把文件系统根或「所有用户的家」本身当任务目录', () => {
    // 判据是 `isDangerousRoot`：**整段相等**，不是前缀——`/home/dev/project` 是正常的
    // 任务目录，不该被拦。盘根与「所有用户的家」那一层两个平台上都命中。
    //
    // 已知缺口（**这次没动**，不是平台差异）：用户自己的那一层主目录（`/home/dev`、
    // `C:\Users\dev`）不在名单里，于是拿它当任务目录能过闸——而任务目录是可写的。
    // 三个平台一致，所以它不是 Windows 引进来的问题；要收紧得单独论证 + 单独一次提交。
    for (const dangerous of [HOST.fsRoot, OTHERS_HOMES]) {
      expect(() => assert([{ source: dangerous, target: WORKDIR, mode: 'rw' }], dangerous), dangerous).toThrow(
        /敏感位置|宿主路径/,
      )
    }
  })

  it('主目录**下面**的项目目录是允许的', () => {
    // 这是最常见的用法，不能因为它在主目录下面就被拒。
    expect(() => assert([{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }], TASK_DIR)).not.toThrow()
  })

  it('空挂载清单通过（docker 后端不会这么用，但不该抛）', () => {
    expect(() => assert([])).not.toThrow()
  })
})

describe('生成的 agent 配置：只读、单文件', () => {
  const CELL_ROOT = HOST.underHome('.abx', 'cells', 'claude-1')
  const SETTINGS = {
    hostPath: HOST.join(CELL_ROOT, 'agents', 'claude', 'settings.json'),
    cellPath: '/home/dev/.claude/settings.json',
  }

  function assertWithConfig(configMounts: readonly SandboxMount[], agentConfigFiles: readonly SandboxConfigFile[] = [SETTINGS]): void {
    assertMountPolicy({
      platform: RUNNING_PLATFORM,
      mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, ...configMounts],
      taskDir: TASK_DIR,
      workdir: WORKDIR,
      agentConfigFiles,
    })
  }

  it('生成的那一个文件可以进舱——哪怕它在主目录下面、哪怕目标在同名目录里', () => {
    expect(() => assertWithConfig([{ source: SETTINGS.hostPath, target: SETTINGS.cellPath, mode: 'ro' }])).not.toThrow()
  })

  it('同一个目录：settings.json 放行，隔壁的 .credentials.json 拒绝', () => {
    // 这一对用例就是「为什么挂载单位必须是文件」的全部理由。
    const credential = HOST.join(CELL_ROOT, 'agents', 'claude', '.credentials.json')
    expect(() => assertWithConfig([{ source: credential, target: '/home/dev/.claude/.credentials.json', mode: 'ro' }])).toThrow(
      /凭据文件/,
    )
  })

  it('生成的文件也必须只读——可写等于让人以为舱内改得动', () => {
    expect(() => assertWithConfig([{ source: SETTINGS.hostPath, target: SETTINGS.cellPath, mode: 'rw' }])).toThrow(/只能只读挂载/)
  })

  it('必须挂回它原本的位置，不能换个地方', () => {
    expect(() => assertWithConfig([{ source: SETTINGS.hostPath, target: '/tmp/settings.json', mode: 'ro' }])).toThrow(
      /挂回它原本的位置/,
    )
  })

  it('把目录形态挂进去会被拒，并指出要的是哪个文件', () => {
    // 「少写一段路径」是这里最像手滑、后果最大的一种错。
    expect(() =>
      assertWithConfig([{ source: HOST.join(CELL_ROOT, 'agents', 'claude'), target: '/home/dev/.claude', mode: 'ro' }]),
    ).toThrow(/这是个目录/)
  })

  it('允许清单里塞一个不是配置文件的名字也拒绝', () => {
    // 名单不是「加进去就放行」：豁免的范围限定在注册表登记过的那几个文件名上，
    // 否则这份名单会慢慢变成「什么都挂」的入口。
    const extra = {
      hostPath: HOST.join(CELL_ROOT, 'agents', 'claude', 'notes.txt'),
      cellPath: '/home/dev/.claude/notes.txt',
    }
    expect(() => assertWithConfig([{ source: extra.hostPath, target: extra.cellPath, mode: 'ro' }], [extra])).toThrow(
      /不是它所在的目录/,
    )
  })

  it('凭据文件即使被写进允许清单也拒绝，而且说的是「凭据」', () => {
    const evil = { hostPath: HOST.join(CELL_ROOT, 'agents', 'claude', 'auth.json'), cellPath: '/home/dev/.claude/auth.json' }
    expect(() => assertWithConfig([{ source: evil.hostPath, target: evil.cellPath, mode: 'ro' }], [evil])).toThrow(
      /凭据文件/,
    )
  })

  it('没进允许清单的宿主路径照旧一律拒绝', () => {
    expect(() => assertWithConfig([], [])).not.toThrow()
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts: [
          { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
          { source: HOST.join(HOST.outsideDir, 'other', 'settings.json'), target: '/srv/other/settings.json', mode: 'ro' },
        ],
        taskDir: TASK_DIR,
        workdir: WORKDIR,
      }),
    ).toThrow(/不允许有别的挂载源/)
  })

  it('多个文件就是多个挂载点，仍然只有一个可写', () => {
    const codex = {
      hostPath: HOST.join(CELL_ROOT, 'agents', 'codex', 'config.toml'),
      cellPath: '/home/dev/.codex/config.toml',
    }
    expect(() =>
      assertWithConfig(
        [
          { source: SETTINGS.hostPath, target: SETTINGS.cellPath, mode: 'ro' },
          { source: codex.hostPath, target: codex.cellPath, mode: 'ro' },
        ],
        [SETTINGS, codex],
      ),
    ).not.toThrow()
  })
})

/**
 * 实例状态目录那几道闸。
 *
 * 这组用例的分量比上面几组重：**多出来的可写挂载面就是持久化的全部代价**，
 * 而它默认落在主目录下面。所以这里不光要盖「正常情况能过」，还要盖住那几种
 * 「看上去正常、其实把宿主主目录交出去了」的写法。
 *
 * 用真实临时目录而不是假路径，是因为 realpath 那道闸只有在路径真的存在时才有意义。
 * 也正因为碰真实文件系统，这一组只能用跑测试这台机器的路径（`HOST` 就是那一份）。
 */
describe('实例状态目录：第二个可写挂载', () => {
  const TEMP_DIRS: string[] = []

  interface InstanceFixture {
    readonly base: string
    readonly homeDir: string
    readonly instancesRoot: string
    readonly stateDir: SandboxStateDir
  }

  afterEach(() => {
    for (const directory of TEMP_DIRS) rmSync(directory, { recursive: true, force: true })
    TEMP_DIRS.length = 0
  })

  /** 造一份真实存在的实例布局：home 在临时目录里，实例根在 home 下面（和默认值同形）。 */
  function fixture(instanceId = 'claude', agentId = 'claude'): InstanceFixture {
    // 先 realpath 再往下用：Windows 的 `%TEMP%` 在 CI 上是 8.3 短名
    // （`C:\Users\RUNNER~1\...`），而下面那些闸会 realpath——字面路径与解析结果
    // 对不上，断言会以一个跟被测行为无关的理由失败。
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-policy-')))
    TEMP_DIRS.push(base)
    const homeDir = path.join(base, 'home')
    const instancesRoot = path.join(homeDir, '.abx', 'instances')
    const hostPath = path.join(instancesRoot, instanceId, agentId)
    mkdirSync(hostPath, { recursive: true })
    return { base, homeDir, instancesRoot, stateDir: { hostPath, cellPath: `${CELL_HOME}/.${agentId}`, agentId } }
  }

  function check(stateDirs: readonly SandboxStateDir[], fixtureInput: InstanceFixture): void {
    assertStateDirPolicy({
      platform: RUNNING_PLATFORM,
      stateDirs,
      instancesRoot: fixtureInput.instancesRoot,
      homeDir: fixtureInput.homeDir,
      cellHome: CELL_HOME,
    })
  }

  it('正常的一格通过：字面路径和 realpath 都在实例根之下', () => {
    const current = fixture()
    expect(() => check([current.stateDir], current)).not.toThrow()
  })

  it('拿宿主真实的 ~/.claude 当状态目录源 → 拒绝', () => {
    // 这是这个任务里最容易被写漏的一种写法：路径看上去完全合理（就是 agent 的
    // home），但它是宿主上**现成的**那一个——里面既有历史也有 `.credentials.json`。
    // 挂进去等于把宿主那台机器上的凭据一起交出去，而命令行里只是一个 -v。
    const stateDir: SandboxStateDir = {
      hostPath: path.join(homedir(), '.claude'),
      cellPath: `${CELL_HOME}/.claude`,
      agentId: 'claude',
    }
    const input = { platform: RUNNING_PLATFORM, stateDirs: [stateDir], homeDir: homedir() }
    expect(() => assertStateDirPolicy(input)).toThrow(MountPolicyViolation)
    expect(() => assertStateDirPolicy(input)).toThrow(/不在实例根/)
  })

  it('同样的写法走完整挂载清单也拒绝（不是只有单独那道闸拦得住）', () => {
    const hostClaude = path.join(homedir(), '.claude')
    const stateDir: SandboxStateDir = { hostPath: hostClaude, cellPath: `${CELL_HOME}/.claude`, agentId: 'claude' }
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [stateDir])
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts,
        taskDir: TASK_DIR,
        workdir: WORKDIR,
        stateDirs: [stateDir],
        homeDir: homedir(),
      }),
    ).toThrow(/不在实例根/)
  })

  it('ABX_INSTANCES_ROOT 配成「所有用户的家」那一层 → 拒绝', () => {
    // 后者比前者隐蔽得多：它看上去只是「主目录的爸爸」，但它是可写挂载源的来源，
    // 指到那儿等于把这一台机器上所有用户的主目录一起交出去。
    // POSIX 上是 `/home`，Windows 上是 `C:\Users`——同一个位置，两种写法。
    const root = defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: OTHERS_HOMES }, homedir())
    expect(root).toBe(OTHERS_HOMES)
    expect(() => assertInstancesRoot({ instancesRoot: root, platform: RUNNING_PLATFORM, homeDir: homedir() })).toThrow(
      MountPolicyViolation,
    )
  })

  it('ABX_INSTANCES_ROOT 配成宿主 home → 拒绝', () => {
    const root = defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: homedir() }, homedir())
    expect(() => assertInstancesRoot({ instancesRoot: root, platform: RUNNING_PLATFORM, homeDir: homedir() })).toThrow(
      /宿主 home/,
    )
  })

  it('实例根不合格时，形状完全正确的状态目录也一起被拒——闸在来源上', () => {
    const current = fixture()
    expect(() =>
      assertStateDirPolicy({
        platform: RUNNING_PLATFORM,
        stateDirs: [current.stateDir],
        instancesRoot: OTHERS_HOMES,
        homeDir: current.homeDir,
      }),
    ).toThrow(MountPolicyViolation)
  })

  it('实例根落在主目录的敏感子目录里也拒绝——让开主目录前缀之后剩的那个口子', () => {
    // 「主目录」那条前缀必须给默认值（`~/.abx/instances`）让路，让开之后
    // `~/.ssh/instances` 就没人拦了。这一条补的就是它。
    for (const name of FORBIDDEN_INSTANCE_ROOT_SUBDIRS) {
      const root = HOST.join(HOST.home, name, 'instances')
      expect(
        () => assertInstancesRoot({ instancesRoot: root, platform: RUNNING_PLATFORM, homeDir: HOST.home }),
        name,
      ).toThrow(/敏感|身份|禁挂/)
    }
  })

  it('实例根本身是文件系统根、是系统目录、带 .. 或者不是绝对路径，都拒绝', () => {
    const roots = [
      HOST.fsRoot,
      HOST.join(HOST.systemDir, 'abx', 'instances'),
      withParentSegment(HOST.home),
      'relative/instances',
    ]
    for (const root of roots) {
      expect(
        () => assertInstancesRoot({ instancesRoot: root, platform: RUNNING_PLATFORM, homeDir: HOST.home }),
        root,
      ).toThrow(MountPolicyViolation)
    }
  })

  it('软链逃逸：字面在实例根下，realpath 却跑出去了 → 拒绝', () => {
    // 闸 1 只看字面路径，而软链是唯一能骗过它的东西：目录名规规矩矩叫
    // `<实例根>/claude/claude`，实际指着别处。所以必须有闸 2。
    const current = fixture()
    const outside = path.join(current.base, 'outside')
    mkdirSync(outside, { recursive: true })
    rmSync(current.stateDir.hostPath, { recursive: true, force: true })
    symlinkSync(outside, current.stateDir.hostPath, 'dir')

    expect(() => check([current.stateDir], current)).toThrow(/跑出实例根/)
  })

  it('目录解析不出来就拒绝——失败关闭，不留「查不出来所以放行」的口子', () => {
    const current = fixture()
    rmSync(current.stateDir.hostPath, { recursive: true, force: true })
    expect(() => check([current.stateDir], current)).toThrow(/解析不了/)
  })

  it('名字正好命中凭据黑名单的目录拒绝', () => {
    const current = fixture()
    const credentialDir: SandboxStateDir = { ...current.stateDir, hostPath: path.join(current.instancesRoot, 'claude', 'auth.json') }
    expect(() => check([credentialDir], current)).toThrow(/凭据文件/)
  })

  it('必须是 <实例根>/<实例 id>/<agentId> 那一格，不能是实例目录本身', () => {
    // 挂实例目录本身的话，`sessions.jsonl` 会跟着进舱——那是 abx 自己的记账，
    // 不该让舱内的 agent 看见，更不该让它能改。
    const current = fixture()
    const tooHigh: SandboxStateDir = { ...current.stateDir, hostPath: path.dirname(current.stateDir.hostPath) }
    expect(() => check([tooHigh], current)).toThrow(/那一格/)
  })

  it('目录名和 agentId 对不上也拒绝', () => {
    const current = fixture()
    const mismatched: SandboxStateDir = { ...current.stateDir, agentId: 'codex' }
    expect(() => check([mismatched], current)).toThrow(/那一格/)
  })

  it('舱内挂载点必须在舱内 home 之下——挂到别处等于没挂', () => {
    const current = fixture()
    const elsewhere: SandboxStateDir = { ...current.stateDir, cellPath: '/tmp/.claude' }
    expect(() => check([elsewhere], current)).toThrow(/不在舱内 home/)
  })

  it('必须是 rw：只读挂进去的话历史写不下来，而界面上看不出异常', () => {
    const current = fixture()
    const mounts: SandboxMount[] = [
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: current.stateDir.hostPath, target: current.stateDir.cellPath, mode: 'ro' },
    ]
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts,
        taskDir: TASK_DIR,
        workdir: WORKDIR,
        stateDirs: [current.stateDir],
        instancesRoot: current.instancesRoot,
        homeDir: current.homeDir,
        cellHome: CELL_HOME,
      }),
    ).toThrow(/必须以 rw 挂载/)
  })

  it('必须挂回它自己的位置', () => {
    const current = fixture()
    const mounts: SandboxMount[] = [
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: current.stateDir.hostPath, target: `${CELL_HOME}/.codex`, mode: 'rw' },
    ]
    const input = {
      platform: RUNNING_PLATFORM,
      mounts,
      taskDir: TASK_DIR,
      workdir: WORKDIR,
      stateDirs: [current.stateDir],
    }
    expect(() =>
      assertMountPolicy({ ...input, instancesRoot: current.instancesRoot, homeDir: current.homeDir, cellHome: CELL_HOME }),
    ).toThrow(/挂回它自己的位置/)
  })

  it('配置文件嵌在状态目录里面：目录整体 rw，配置那一格仍然 ro', () => {
    // 这就是真实形态：生成的配置**长在**状态目录里，于是它在可写挂载内部又套了
    // 一层只读挂载。docker 的嵌套绑定是「深的目标赢」，所以两者可以共存。
    const current = fixture()
    const settings: SandboxConfigFile = {
      hostPath: path.join(current.stateDir.hostPath, 'settings.json'),
      cellPath: `${current.stateDir.cellPath}/settings.json`,
    }
    writeFileSync(settings.hostPath, '{}')

    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [settings], [current.stateDir])
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: current.stateDir.hostPath, target: current.stateDir.cellPath, mode: 'rw' },
      { source: settings.hostPath, target: settings.cellPath, mode: 'ro' },
    ])
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts,
        taskDir: TASK_DIR,
        workdir: WORKDIR,
        agentConfigFiles: [settings],
        stateDirs: [current.stateDir],
        instancesRoot: current.instancesRoot,
        homeDir: current.homeDir,
        cellHome: CELL_HOME,
      }),
    ).not.toThrow()
  })

  it('可写的上限是「任务目录 1 个 + 每个状态目录 1 个」，再多一个就拒', () => {
    const current = fixture()
    const mounts: SandboxMount[] = [
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: current.stateDir.hostPath, target: current.stateDir.cellPath, mode: 'rw' },
      { source: HOST.join(HOST.outsideDir, 'extra'), target: '/srv/extra', mode: 'rw' },
    ]
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts,
        taskDir: TASK_DIR,
        workdir: WORKDIR,
        stateDirs: [current.stateDir],
        instancesRoot: current.instancesRoot,
        homeDir: current.homeDir,
        cellHome: CELL_HOME,
      }),
    ).toThrow(/可写挂载最多/)
  })

  it('没有状态目录时不碰实例根——免得凭空多出一种跟跑测试的人的主目录有关的失败', () => {
    expect(() =>
      assertMountPolicy({
        platform: RUNNING_PLATFORM,
        mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }],
        taskDir: TASK_DIR,
        workdir: WORKDIR,
      }),
    ).not.toThrow()
  })
})

describe('findRiskyFilesInTaskDir', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  function tempDir(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-task-'))
    directories.push(directory)
    return directory
  }

  it('干净的目录给空数组', () => {
    expect(findRiskyFilesInTaskDir(tempDir())).toEqual([])
  })

  it('找出 .env / .git-credentials 这类文件', () => {
    const directory = tempDir()
    writeFileSync(path.join(directory, '.env'), 'X=1')
    writeFileSync(path.join(directory, '.git-credentials'), 'https://x:y@github.com')
    expect([...findRiskyFilesInTaskDir(directory)].sort()).toEqual(['.env', '.git-credentials'])
  })

  it('目录不存在时不抛', () => {
    expect(findRiskyFilesInTaskDir(HOST.join(HOST.fsRoot, 'definitely', 'not', 'here'))).toEqual([])
  })
})

/*
 * 共享挂载：本作业新加的那一类。
 *
 * 与另外两类的关系是「构造在 shared.ts，闸门在这里」：`resolveSharedMounts()` 算出
 * 只读挂载（那一步要读文件系统），这份名单把它带进闸门，闸门只核形态。所以下面断言
 * 的是「名单放行 + 形态不对就拒」，不复述 shared.ts 那边的判定。
 */
describe('共享挂载', () => {
  const SHARED: SandboxMount = { source: HOST.join(HOST.home, 'projects', 'notes'), target: '/shared/notes', mode: 'ro' }
  const SHARED_SECOND: SandboxMount = { source: HOST.join(HOST.home, 'data'), target: '/shared/data', mode: 'ro' }

  function check(mounts: readonly SandboxMount[], sharedMounts: readonly SandboxMount[]): void {
    assertMountPolicy({ platform: RUNNING_PLATFORM, mounts, taskDir: TASK_DIR, workdir: WORKDIR, sharedMounts })
  }

  it('buildMounts 把它们接在最后，形态原样带过去', () => {
    expect(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED, SHARED_SECOND])).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      SHARED,
      SHARED_SECOND,
    ])
  })

  it('不传共享条目就是老样子——现有调用点一个都不用改', () => {
    expect(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [])).toHaveLength(1)
  })

  it('策略对象上写明共享只有只读一种', () => {
    expect(MOUNT_POLICY.sharedMountMode).toBe('ro')
  })

  it('共享源住在主目录下面也放行——那正是共享要开的口子', () => {
    // 「主目录」那条前缀对配置文件是对的，而共享条目恰恰住在那里，所以要让路。
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED]), [SHARED])).not.toThrow()
  })

  it('共享挂载不计入可写上限：只读的东西不占可写的额度', () => {
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED, SHARED_SECOND])

    expect(mounts.filter((mount) => mount.mode === 'rw')).toHaveLength(1)
    expect(() => check(mounts, [SHARED, SHARED_SECOND])).not.toThrow()
  })

  it('没进名单的共享挂载一个都不放——名单是收紧用的', () => {
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED]), [])).toThrow(/一律不进舱内/)
  })

  it('共享挂载被改成可写 → 拒绝，理由说清「改坏了回不去」', () => {
    const writable = { ...SHARED, mode: 'rw' as const }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [writable]), [SHARED])).toThrow(/只能只读挂载/)
  })

  it('共享挂载被挂到共享区外面 → 拒绝', () => {
    const elsewhere = { ...SHARED, target: `${CELL_HOME}/notes` }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [elsewhere]), [SHARED])).toThrow(/必须挂在 \/shared/)
  })

  it('挂载点对得上、来源被换掉 → 拒绝（两者必须一起对）', () => {
    const swapped = { ...SHARED, source: HOST.systemDir }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [swapped]), [SHARED])).toThrow(/批准的来源/)
  })

  it('两个共享条目挂同一个位置 → 拒绝：后一个会把前一个盖掉', () => {
    const clashing = { ...SHARED_SECOND, target: SHARED.target }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED, clashing]), [SHARED, clashing])).toThrow(
      /同一个位置/,
    )
  })

  it('共享源是凭据文件时照样拒绝——凭据那条规则排在名单前面', () => {
    const credential = {
      source: HOST.join(HOST.home, 'projects', '.env'),
      target: '/shared/.env',
      mode: 'ro' as const,
    }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [credential]), [credential])).toThrow(/凭据文件/)
  })

  it('目标带 .. 的共享挂载也拦得住（形状检查前的通用那几条照样生效）', () => {
    const traversal = { source: SHARED.source, target: `/shared${'/../..'}/etc`, mode: 'ro' as const }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [traversal]), [traversal])).toThrow(MountPolicyViolation)
  })
})
