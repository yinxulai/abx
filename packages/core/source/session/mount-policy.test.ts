import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_SHIM_CELL_PATH, MCP_SHIM_FILE_NAME } from '@abx/contracts'
import type { SandboxConfigFile, SandboxMount, SandboxRuntimeFile, SandboxStateDir } from './backend'
import { INSTANCES_ROOT_ENV, defaultInstancesRoot } from './instance'
import {
  DOCKER_SOCKET_PATH,
  FORBIDDEN_CREDENTIAL_FILE_PATTERNS,
  FORBIDDEN_INSTANCE_ROOT_SUBDIRS,
  MOUNT_POLICY,
  MountPolicyViolation,
  RUNTIME_FILE_SHAPES,
  assertInstancesRoot,
  assertMountPolicy,
  assertStateDirPolicy,
  findRiskyFilesInTaskDir,
  isForbiddenMountSource,
  matchCredentialFileRule,
} from './mount-policy'

const WORKDIR = '/workspace'
const TASK_DIR = '/home/dev/projects/thing'

function assert(mounts: readonly SandboxMount[], taskDir = TASK_DIR): void {
  assertMountPolicy({ mounts, taskDir, workdir: WORKDIR })
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
    expect(mount?.source.startsWith('/')).toBe(true)
  })

  it('生成的配置逐个只读挂进来，任务目录仍是唯一的可写挂载', () => {
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [
      { hostPath: '/home/dev/.abx/cells/c1/agents/claude/settings.json', cellPath: '/home/dev/.claude/settings.json' },
    ])
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: '/home/dev/.abx/cells/c1/agents/claude/settings.json', target: '/home/dev/.claude/settings.json', mode: 'ro' },
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
    const mounts = MOUNT_POLICY.buildMounts(
      TASK_DIR,
      WORKDIR,
      [],
      [{ hostPath: '/home/dev/.abx/instances/claude/claude', cellPath: '/home/node/.claude', agentId: 'claude' }],
    )
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: '/home/dev/.abx/instances/claude/claude', target: '/home/node/.claude', mode: 'rw' },
    ])
  })
})

describe('isForbiddenMountSource', () => {
  it('主目录、/etc、docker socket 都算禁挂', () => {
    expect(isForbiddenMountSource('/home/dev/.ssh')).toBe(true)
    expect(isForbiddenMountSource('/home')).toBe(true)
    expect(isForbiddenMountSource('/root/.aws')).toBe(true)
    expect(isForbiddenMountSource('/etc/shadow')).toBe(true)
    expect(isForbiddenMountSource(DOCKER_SOCKET_PATH)).toBe(true)
    expect(isForbiddenMountSource('/proc/1/root')).toBe(true)
  })

  it('主目录下面的路径也在禁挂前缀里', () => {
    // 注意：这个函数问的是「能不能作为挂载源」。任务目录是豁免的，
    // 见下面 assertMountPolicy 那组用例——两件事，两个判断。
    expect(isForbiddenMountSource('/home/dev/projects/thing')).toBe(true)
  })

  it('凭据文件即使在安全目录下也算禁挂', () => {
    expect(isForbiddenMountSource('/srv/work/.env')).toBe(true)
    expect(isForbiddenMountSource('/opt/keys/server.pem')).toBe(true)
    expect(isForbiddenMountSource('/home/dev/.codex/auth.json')).toBe(true)
  })

  it('普通目录不禁', () => {
    expect(isForbiddenMountSource('/srv/work')).toBe(false)
    expect(isForbiddenMountSource('/opt/data')).toBe(false)
    expect(isForbiddenMountSource('/srv/work/settings.json')).toBe(false)
  })

  it('前缀相似但不同级的路径不会误判', () => {
    // `/homely` 不是 `/home` 下面。
    expect(isForbiddenMountSource('/homely/data')).toBe(false)
    expect(isForbiddenMountSource('/etcetera/data')).toBe(false)
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
        { source: '/home/dev', target: '/home/dev', mode: 'ro' },
      ]),
    ).toThrow(MountPolicyViolation)
  })

  it('拒绝挂载 docker socket', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: DOCKER_SOCKET_PATH, target: DOCKER_SOCKET_PATH, mode: 'rw' },
      ]),
    ).toThrow(/docker socket/)
  })

  it('拒绝挂载 SSH 目录', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: '/home/dev/.ssh', target: '/root/.ssh', mode: 'ro' },
      ]),
    ).toThrow(/宿主路径一律不进舱内/)
  })

  it('拒绝挂载凭据文件，且说清它是凭据而不是一句笼统的「禁止路径」', () => {
    // 这条消息要说得出「为什么」：那个路径看上去跟配置文件毫无区别，
    // 只报「禁止路径」的话，用户只会去找一个更宽的挂载方式。
    const credential = '/home/dev/.claude/.credentials.json'
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: credential, target: credential, mode: 'ro' },
      ]),
    ).toThrow(/凭据文件/)
  })

  it('同目录的凭据文件被拒，同目录的配置文件不受影响', () => {
    const directory = '/home/dev/.claude'
    expect(() =>
      assert([{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, { source: `${directory}/auth.json`, target: `${directory}/auth.json`, mode: 'ro' }]),
    ).toThrow(/凭据文件/)

    // 只差一个文件名。前缀规则区分不了这两者，所以凭据那条必须按文件名判——
    // （配置文件怎么合法地挂进来见 docker-backend 的用例。）
    expect(matchCredentialFileRule(`${directory}/settings.json`)).toBeNull()
  })

  it('拒绝两个可写挂载', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: '/srv/other', target: '/srv/other', mode: 'rw' },
      ]),
    ).toThrow(MountPolicyViolation)
  })

  it('拒绝任务目录之外的任何挂载源，哪怕是只读的', () => {
    expect(() =>
      assert([
        { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
        { source: '/srv/data', target: '/srv/data', mode: 'ro' },
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
    // `..` 能把一个看起来人畜无害的路径变成 /home。
    expect(() => assert([{ source: '/srv/../home/dev', target: WORKDIR, mode: 'rw' }])).toThrow(/不允许出现 \.\./)
  })

  it('拒绝把 / 或 /home 本身当任务目录', () => {
    expect(() => assert([{ source: '/', target: WORKDIR, mode: 'rw' }], '/')).toThrow(/敏感位置/)
    expect(() => assert([{ source: '/home', target: WORKDIR, mode: 'rw' }], '/home')).toThrow(/敏感位置/)
  })

  it('主目录**下面**的项目目录是允许的', () => {
    // 这是最常见的用法，不能因为它在 /home 下面就被拒。
    expect(() => assert([{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }], TASK_DIR)).not.toThrow()
  })

  it('空挂载清单通过（docker 后端不会这么用，但不该抛）', () => {
    expect(() => assert([])).not.toThrow()
  })
})

describe('生成的 agent 配置：只读、单文件', () => {
  const CELL_ROOT = '/home/dev/.abx/cells/claude-1'
  const SETTINGS = {
    hostPath: `${CELL_ROOT}/agents/claude/settings.json`,
    cellPath: '/home/dev/.claude/settings.json',
  }

  function assertWithConfig(configMounts: readonly SandboxMount[], agentConfigFiles: readonly SandboxConfigFile[] = [SETTINGS]): void {
    assertMountPolicy({
      mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, ...configMounts],
      taskDir: TASK_DIR,
      workdir: WORKDIR,
      agentConfigFiles,
    })
  }

  it('生成的那一个文件可以进舱——哪怕它在 /home 下面、哪怕目标在同名目录里', () => {
    expect(() => assertWithConfig([{ source: SETTINGS.hostPath, target: SETTINGS.cellPath, mode: 'ro' }])).not.toThrow()
  })

  it('同一个目录：settings.json 放行，隔壁的 .credentials.json 拒绝', () => {
    // 这一对用例就是「为什么挂载单位必须是文件」的全部理由。
    const credential = `${CELL_ROOT}/agents/claude/.credentials.json`
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
    expect(() => assertWithConfig([{ source: `${CELL_ROOT}/agents/claude`, target: '/home/dev/.claude', mode: 'ro' }])).toThrow(
      /这是个目录/,
    )
  })

  it('允许清单里塞一个不是配置文件的名字也拒绝', () => {
    // 名单不是「加进去就放行」：豁免的范围限定在注册表登记过的那几个文件名上，
    // 否则这份名单会慢慢变成「什么都挂」的入口。
    const extra = { hostPath: `${CELL_ROOT}/agents/claude/notes.txt`, cellPath: '/home/dev/.claude/notes.txt' }
    expect(() => assertWithConfig([{ source: extra.hostPath, target: extra.cellPath, mode: 'ro' }], [extra])).toThrow(
      /不是它所在的目录/,
    )
  })

  it('凭据文件即使被写进允许清单也拒绝，而且说的是「凭据」', () => {
    const evil = { hostPath: `${CELL_ROOT}/agents/claude/auth.json`, cellPath: '/home/dev/.claude/auth.json' }
    expect(() => assertWithConfig([{ source: evil.hostPath, target: evil.cellPath, mode: 'ro' }], [evil])).toThrow(
      /凭据文件/,
    )
  })

  it('没进允许清单的宿主路径照旧一律拒绝', () => {
    expect(() => assertWithConfig([], [])).not.toThrow()
    expect(() =>
      assertMountPolicy({
        mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, { source: '/srv/other/settings.json', target: '/srv/other/settings.json', mode: 'ro' }],
        taskDir: TASK_DIR,
        workdir: WORKDIR,
      }),
    ).toThrow(/不允许有别的挂载源/)
  })

  it('多个文件就是多个挂载点，仍然只有一个可写', () => {
    const codex = { hostPath: `${CELL_ROOT}/agents/codex/config.toml`, cellPath: '/home/dev/.codex/config.toml' }
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
 */
describe('实例状态目录：第二个可写挂载', () => {
  const CELL_HOME = '/home/node'
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
    expect(() => assertStateDirPolicy({ stateDirs: [stateDir], homeDir: homedir() })).toThrow(MountPolicyViolation)
    expect(() => assertStateDirPolicy({ stateDirs: [stateDir], homeDir: homedir() })).toThrow(/不在实例根/)
  })

  it('同样的写法走完整挂载清单也拒绝（不是只有单独那道闸拦得住）', () => {
    const hostClaude = path.join(homedir(), '.claude')
    const stateDir: SandboxStateDir = { hostPath: hostClaude, cellPath: `${CELL_HOME}/.claude`, agentId: 'claude' }
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [stateDir])
    expect(() =>
      assertMountPolicy({ mounts, taskDir: TASK_DIR, workdir: WORKDIR, stateDirs: [stateDir], homeDir: homedir() }),
    ).toThrow(/不在实例根/)
  })

  it('ABX_INSTANCES_ROOT 配成 /home → 拒绝', () => {
    // 后者比前者隐蔽得多：`/home` 看上去只是「主目录的爸爸」，但它是可写挂载源的
    // 来源，指到那儿等于把这一台机器上所有用户的主目录一起交出去。
    const root = defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: '/home' }, homedir())
    expect(root).toBe('/home')
    expect(() => assertInstancesRoot(root, homedir())).toThrow(MountPolicyViolation)
  })

  it('ABX_INSTANCES_ROOT 配成宿主 home → 拒绝', () => {
    const root = defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: homedir() }, homedir())
    expect(() => assertInstancesRoot(root, homedir())).toThrow(/宿主 home/)
  })

  it('实例根不合格时，形状完全正确的状态目录也一起被拒——闸在来源上', () => {
    const current = fixture()
    expect(() => assertStateDirPolicy({ stateDirs: [current.stateDir], instancesRoot: '/home', homeDir: current.homeDir })).toThrow(
      MountPolicyViolation,
    )
  })

  it('实例根落在主目录的敏感子目录里也拒绝——让开 /home 前缀之后剩的那个口子', () => {
    // `/home` 前缀必须给默认值（`~/.abx/instances`）让路，让开之后 `~/.ssh/instances`
    // 就没人拦了。这一条补的就是它。
    for (const name of FORBIDDEN_INSTANCE_ROOT_SUBDIRS) {
      const root = path.join('/home/dev', name, 'instances')
      expect(() => assertInstancesRoot(root, '/home/dev')).toThrow(/敏感|身份|禁挂前缀/)
    }
  })

  it('实例根本身是文件系统根、是 /etc、带 .. 或者不是绝对路径，都拒绝', () => {
    expect(() => assertInstancesRoot('/', '/home/dev')).toThrow(MountPolicyViolation)
    expect(() => assertInstancesRoot('/etc/abx/instances', '/home/dev')).toThrow(MountPolicyViolation)
    expect(() => assertInstancesRoot('/home/dev/../..', '/home/dev')).toThrow(MountPolicyViolation)
    expect(() => assertInstancesRoot('relative/instances', '/home/dev')).toThrow(/绝对路径/)
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
      { source: current.stateDir.hostPath, target: '/home/node/.codex', mode: 'rw' },
    ]
    const input = { mounts, taskDir: TASK_DIR, workdir: WORKDIR, stateDirs: [current.stateDir] }
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
      { source: '/srv/extra', target: '/srv/extra', mode: 'rw' },
    ]
    expect(() =>
      assertMountPolicy({
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
    expect(() => assertMountPolicy({ mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }], taskDir: TASK_DIR, workdir: WORKDIR })).not.toThrow()
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
    expect(findRiskyFilesInTaskDir('/definitely/not/here')).toEqual([])
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
  const SHARED: SandboxMount = { source: '/home/dev/projects/notes', target: '/shared/notes', mode: 'ro' }
  const SHARED_SECOND: SandboxMount = { source: '/home/dev/data', target: '/shared/data', mode: 'ro' }

  function check(mounts: readonly SandboxMount[], sharedMounts: readonly SandboxMount[]): void {
    assertMountPolicy({ mounts, taskDir: TASK_DIR, workdir: WORKDIR, sharedMounts })
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
    // `/home` 在禁挂前缀里（对配置文件那条规则是对的），共享条目恰恰住在那里。
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
    const elsewhere = { ...SHARED, target: '/home/node/notes' }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [elsewhere]), [SHARED])).toThrow(/必须挂在 \/shared/)
  })

  it('挂载点对得上、来源被换掉 → 拒绝（两者必须一起对）', () => {
    const swapped = { ...SHARED, source: '/etc' }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [swapped]), [SHARED])).toThrow(/批准的来源/)
  })

  it('两个共享条目挂同一个位置 → 拒绝：后一个会把前一个盖掉', () => {
    const clashing = { ...SHARED_SECOND, target: SHARED.target }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [SHARED, clashing]), [SHARED, clashing])).toThrow(
      /同一个位置/,
    )
  })

  it('共享源是凭据文件时照样拒绝——凭据那条规则排在名单前面', () => {
    const credential = { source: '/home/dev/projects/.env', target: '/shared/.env', mode: 'ro' as const }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [credential]), [credential])).toThrow(/凭据文件/)
  })

  it('目标带 .. 的共享挂载也拦得住（形状检查前的通用那几条照样生效）', () => {
    const traversal = { source: SHARED.source, target: '/shared/../../etc', mode: 'ro' as const }
    expect(() => check(MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [traversal]), [traversal])).toThrow(MountPolicyViolation)
  })
})

/**
 * 运行时文件：abx 自己写、只读挂进舱的那一个**会跑起来**的脚本。
 *
 * 这一组的分量在于：前面几类挂载进去的是数据（配置、状态、共享的资料），
 * 而这一类进舱的东西会被 agent 拿去 `node` 起来。所以断言的重点不是「能挂」，
 * 是**换个名字、换个落点、换个来源都不行**。
 */
describe('运行时文件：只读、单文件、形状写死', () => {
  const TEMP_DIRS: string[] = []

  afterEach(() => {
    for (const directory of TEMP_DIRS) rmSync(directory, { recursive: true, force: true })
    TEMP_DIRS.length = 0
  })

  interface RuntimeFixture {
    readonly homeDir: string
    readonly runtimeRoot: string
    readonly file: SandboxRuntimeFile
  }

  /** 造一份真实现场：home 在临时目录里，运行时根在 home 下面（和默认值同形）。 */
  function fixture(cellId = 'claude-20261023-abc'): RuntimeFixture {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-runtime-')))
    TEMP_DIRS.push(base)
    const homeDir = path.join(base, 'home')
    const runtimeRoot = path.join(homeDir, '.abx', 'runtime')
    const directory = path.join(runtimeRoot, cellId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, MCP_SHIM_FILE_NAME), '// shim\n')
    return {
      homeDir,
      runtimeRoot,
      file: { hostPath: path.join(directory, MCP_SHIM_FILE_NAME), cellPath: MCP_SHIM_CELL_PATH },
    }
  }

  function check(f: RuntimeFixture, mounts: readonly SandboxMount[], files: readonly SandboxRuntimeFile[]): void {
    assertMountPolicy({
      mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }, ...mounts],
      taskDir: TASK_DIR,
      workdir: WORKDIR,
      runtimeFiles: files,
      runtimeRoot: f.runtimeRoot,
      homeDir: f.homeDir,
    })
  }

  it('buildMounts 把它当成单个只读文件，可写挂载还是只有一个', () => {
    const f = fixture()
    const mounts = MOUNT_POLICY.buildMounts(TASK_DIR, WORKDIR, [], [], [], [f.file])
    expect(mounts).toEqual([
      { source: TASK_DIR, target: WORKDIR, mode: 'rw' },
      { source: f.file.hostPath, target: MCP_SHIM_CELL_PATH, mode: 'ro' },
    ])
    expect(mounts.filter((mount) => mount.mode === 'rw')).toHaveLength(1)
  })

  it('形状对、来源在运行时根里：放行——虽然它整个落在 /home 下面', () => {
    const f = fixture()
    expect(() => check(f, [{ source: f.file.hostPath, target: f.file.cellPath, mode: 'ro' }], [f.file])).not.toThrow()
  })

  it('挂成可写 → 拒绝：那等于舱内能改掉宿主要跑的那份代码', () => {
    const f = fixture()
    expect(() =>
      check(f, [{ source: f.file.hostPath, target: f.file.cellPath, mode: 'rw' }], [f.file]),
    ).toThrow(/只能只读挂载/)
  })

  it('换个落点 → 拒绝：agent 的配置里写着用 node 跑那一个固定路径', () => {
    const f = fixture()
    const hijack = { ...f.file, cellPath: '/usr/local/bin/node' }
    expect(() => check(f, [{ source: hijack.hostPath, target: hijack.cellPath, mode: 'ro' }], [hijack])).toThrow(
      /挂回它自己的位置/,
    )
  })

  it('换个名字 → 拒绝：表里只有那一个名字，多一个名字就是多一个能跑的东西', () => {
    const f = fixture()
    const renamed = { ...f.file, hostPath: path.join(path.dirname(f.file.hostPath), 'evil.mjs') }
    writeFileSync(renamed.hostPath, '// evil\n')
    expect(() => check(f, [{ source: renamed.hostPath, target: renamed.cellPath, mode: 'ro' }], [renamed])).toThrow(
      /只允许 abx-mcp-shim\.mjs/,
    )
  })

  it('来源不在运行时根里 → 拒绝，哪怕名字和落点都对', () => {
    // 这一条挡的是「运行期给的来源」：名字可以撞，位置撞不了。
    const f = fixture()
    const outside = { ...f.file, hostPath: path.join(f.homeDir, '.ssh', MCP_SHIM_FILE_NAME) }
    mkdirSync(path.dirname(outside.hostPath), { recursive: true })
    writeFileSync(outside.hostPath, '// planted\n')
    expect(() => check(f, [{ source: outside.hostPath, target: outside.cellPath, mode: 'ro' }], [outside])).toThrow(
      /不在运行时根/,
    )
  })

  it('来源不是一个真文件 → 拒绝，理由说清 docker 会替你造一个空目录', () => {
    const f = fixture()
    // 两种「不是真文件」：路径不存在，以及那是个同名目录。
    const missing = { ...f.file, hostPath: path.join(f.runtimeRoot, 'other-cell', MCP_SHIM_FILE_NAME) }
    const isDirectory = { ...f.file, hostPath: path.join(f.runtimeRoot, 'as-dir', MCP_SHIM_FILE_NAME) }
    mkdirSync(isDirectory.hostPath, { recursive: true })

    for (const ghost of [missing, isDirectory]) {
      expect(() => check(f, [{ source: ghost.hostPath, target: ghost.cellPath, mode: 'ro' }], [ghost]), ghost.hostPath).toThrow(
        /不是一个存在的文件/,
      )
    }
  })

  it('运行时根本身也过闸：home、/etc、相对路径都不行', () => {
    const f = fixture()
    for (const [root, pattern] of [
      [f.homeDir, /宿主 home/],
      ['/etc/abx', /禁挂前缀/],
      ['relative/runtime', /绝对路径/],
      ['/', /文件系统的根/],
      ['/tmp/../etc/x', /不允许出现 \.\./],
    ] as const) {
      expect(() =>
        assertMountPolicy({
          mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }],
          taskDir: TASK_DIR,
          workdir: WORKDIR,
          runtimeFiles: [f.file],
          runtimeRoot: root,
          homeDir: f.homeDir,
        }),
        root,
      ).toThrow(pattern)
    }
  })

  it('没有运行时文件时不碰运行时根——环境变量没配不该让会话起不来', () => {
    expect(() =>
      assertMountPolicy({
        mounts: [{ source: TASK_DIR, target: WORKDIR, mode: 'rw' }],
        taskDir: TASK_DIR,
        workdir: WORKDIR,
        runtimeRoot: '/etc/whatever',
        homeDir: '/home/dev',
      }),
    ).not.toThrow()
  })

  it('那张形状表只有一条，而且就是 shim 那一个', () => {
    // 多一条 = 往舱里多挂一个能跑的脚本。改它必须是一次看得见的改动。
    expect(RUNTIME_FILE_SHAPES).toEqual([{ fileName: MCP_SHIM_FILE_NAME, cellPath: MCP_SHIM_CELL_PATH }])
  })
})
