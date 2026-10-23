import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxConfigFile, SandboxMount } from './backend'
import {
  DOCKER_SOCKET_PATH,
  FORBIDDEN_CREDENTIAL_FILE_PATTERNS,
  MOUNT_POLICY,
  MountPolicyViolation,
  assertMountPolicy,
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
