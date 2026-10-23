import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SharedEntry } from '@abx/contracts'
import { MountPolicyViolation } from './mount-policy'
import { MAX_REPORTED_CREDENTIAL_FILES, resolveSharedMounts, type ResolveSharedMountsOptions } from './shared'

/*
 * 这一层是「共享条目 → 只读挂载」的**全部**判定：挂哪儿、什么不能挂、拒了怎么说。
 * 容器那一边（真挂上之后舱内看得见吗、写得进去吗）由 e2e-shared.sh 用真 docker 验。
 *
 * 每个用例都在自己的临时目录里跑，而且 home 与实例根都显式传进去——
 * 绝不能让用例跟着跑测试的那个人的主目录走。
 */

let work: string

/** 宿主 home 就是临时目录本身，于是「主目录下面」这件事在用例里是可造的。 */
function options(overrides: Partial<ResolveSharedMountsOptions> = {}): ResolveSharedMountsOptions {
  return { homeDir: work, instancesRoot: path.join(work, 'instances'), ...overrides }
}

function resolve(entries: readonly SharedEntry[], overrides: Partial<ResolveSharedMountsOptions> = {}) {
  return resolveSharedMounts(entries, options(overrides))
}

/** 造一个目录，里面放几个普通文件。 */
function makeDirectory(name: string, files: readonly string[] = ['readme.md']): string {
  const directory = path.join(work, name)
  mkdirSync(directory, { recursive: true })
  for (const file of files) {
    const target = path.join(directory, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `content of ${file}\n`)
  }
  return directory
}

function makeFile(name: string, content = 'x\n'): string {
  const file = path.join(work, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function directoryEntry(target: string): SharedEntry {
  return { path: target, kind: 'directory' }
}

beforeEach(() => {
  work = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-shared-')))
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('resolveSharedMounts · 挂载形态', () => {
  it('目录整挂成一条只读挂载，绝不递归展开成单文件', () => {
    const notes = makeDirectory('notes', ['a.md', 'b.md', 'sub/c.md'])

    const { mounts, rejected } = resolve([directoryEntry(notes)])

    expect(rejected).toEqual([])
    expect(mounts).toEqual([{ source: notes, target: '/shared/notes', mode: 'ro' }])
  })

  it('目录里有多少文件都不影响挂载条数——挂的是目录本身，不是当时的快照', () => {
    const notes = makeDirectory('notes', ['a.md'])
    const before = resolve([directoryEntry(notes)]).mounts

    makeFile('notes/later.md')

    const after = resolve([directoryEntry(notes)]).mounts
    expect(after).toEqual(before)
    expect(after).toHaveLength(1)
  })

  it('单个文件也挂，同样是只读', () => {
    const file = makeFile('specs/design.md')

    const { mounts } = resolve([{ path: file, kind: 'file' }])
    expect(mounts).toEqual([{ source: file, target: '/shared/design.md', mode: 'ro' }])
  })

  it('两个不同目录重名时往后排 -2、-3，两个都在', () => {
    const first = makeDirectory('a/notes')
    const second = makeDirectory('b/notes')
    const third = makeDirectory('c/notes')

    const { mounts } = resolve([directoryEntry(first), directoryEntry(second), directoryEntry(third)])

    expect(mounts.map((mount) => mount.target)).toEqual(['/shared/notes', '/shared/notes-2', '/shared/notes-3'])
    expect(mounts.map((mount) => mount.source)).toEqual([first, second, third])
  })

  it('同一批条目每次算出来的目标一致（舱内路径不能随机）', () => {
    const entries = [directoryEntry(makeDirectory('a/notes')), directoryEntry(makeDirectory('b/notes'))]

    expect(resolve(entries).mounts).toEqual(resolve(entries).mounts)
  })

  it('名字消毒：不合法的 basename 用 shared-<序号> 兜底', () => {
    const weird = path.join(work, 'bad\u0001name')
    mkdirSync(weird)

    const { mounts } = resolve([directoryEntry(weird)])
    expect(mounts[0]?.target).toBe('/shared/shared-1')
  })

  it('舱内共享区根可以换，但默认是 /shared', () => {
    const notes = makeDirectory('notes')
    // 末尾多个斜杠不能变成 `/shared//notes`。
    expect(resolve([directoryEntry(notes)], { cellRoot: '/shared/' }).mounts[0]?.target).toBe('/shared/notes')
    expect(resolve([directoryEntry(notes)], { cellRoot: '/mnt/x' }).mounts[0]?.target).toBe('/mnt/x/notes')
  })
})

describe('resolveSharedMounts · kind 以宿主为准', () => {
  it('调用方谎报 kind 也没用：目录就是目录', () => {
    const notes = makeDirectory('notes')

    const lying = resolve([{ path: notes, kind: 'file' }])
    expect(lying.mounts).toEqual(resolve([directoryEntry(notes)]).mounts)
  })

  it('谎报成目录的文件，按文件挂', () => {
    const file = makeFile('design.md')

    const lying = resolve([{ path: file, kind: 'directory' }])
    expect(lying.mounts).toEqual([{ source: file, target: '/shared/design.md', mode: 'ro' }])
  })

  it('设备文件（既不是普通文件也不是目录）拒绝', () => {
    // 套接字、设备文件都能被 stat 出来，但都不能当共享源：前者是别的进程的接口，
    // 后者是内核的。判据是 isFile / isDirectory，两者都不成立就拒。
    const socket = path.join(work, 'agent.sock')
    const server = createServer()
    server.listen(socket)
    try {
      const { mounts, rejected } = resolve([{ path: socket, kind: 'file' }])

      expect(mounts).toEqual([])
      expect(rejected[0]?.reason).toContain('既不是普通文件也不是目录')
    } finally {
      server.close()
    }
  })
})

describe('resolveSharedMounts · 形状与存在性', () => {
  it('空路径、相对路径、带 .. 的路径一律拒绝，并且不抛', () => {
    const { mounts, rejected } = resolve([
      { path: '', kind: 'file' },
      { path: 'notes/design.md', kind: 'file' },
      { path: '/home/dev/../../etc', kind: 'directory' },
    ])

    expect(mounts).toEqual([])
    expect(rejected).toHaveLength(3)
    expect(rejected[0]?.reason).toContain('空')
    expect(rejected[1]?.reason).toContain('绝对路径')
    expect(rejected[2]?.reason).toContain('..')
  })

  it('宿主上不存在的条目被拒，理由是「找不到」，而不是静默跳过', () => {
    const { mounts, rejected } = resolve([directoryEntry(path.join(work, 'gone'))])

    expect(mounts).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toContain('找不到')
  })

  it('一条坏条目不影响别的条目：好的照样挂上', () => {
    const notes = makeDirectory('notes')

    const { mounts, rejected } = resolve([directoryEntry(path.join(work, 'gone')), directoryEntry(notes)])

    expect(mounts).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})

describe('resolveSharedMounts · 凭据文件', () => {
  it('条目本身就是凭据文件（.env）时拒绝，并且点名是哪条规则', () => {
    const file = makeFile('secrets/.env')

    const { mounts, rejected } = resolve([{ path: file, kind: 'file' }])

    expect(mounts).toEqual([])
    expect(rejected[0]?.reason).toContain('.env')
    expect(rejected[0]?.reason).toContain('凭据')
  })

  it('目录里**任何一层**命中凭据规则，整个目录被拒，并列出相对路径', () => {
    const project = makeDirectory('project', ['src/main.ts', 'notes/.env', 'deploy/tls.pem'])

    const { mounts, rejected } = resolve([directoryEntry(project)])

    expect(mounts).toEqual([])
    expect(rejected).toHaveLength(1)
    const reason = rejected[0]?.reason ?? ''
    expect(reason).toContain('notes/.env')
    expect(reason).toContain('deploy/tls.pem')
    expect(reason).toContain('整个目录')
  })

  it('理由里写清了「为什么拒整个目录」，而不只是「禁止」', () => {
    const project = makeDirectory('project', ['.credentials.json'])

    const reason = resolve([directoryEntry(project)]).rejected[0]?.reason ?? ''

    // 嵌套挂载只能加不能减 + 静默少挂比直接拒绝更危险，这两句是用户能照着改的前提。
    expect(reason).toContain('只能往上加')
    expect(reason).toContain('直接拒绝')
  })

  it('命中很多时只列前几条，其余给总数', () => {
    const many = Array.from({ length: MAX_REPORTED_CREDENTIAL_FILES + 5 }, (_, index) => `f${index}.env`)
    const project = makeDirectory('project', many)

    const reason = resolve([directoryEntry(project)]).rejected[0]?.reason ?? ''

    expect(reason).toContain(`共 ${many.length} 个`)
    expect(reason).toContain(`另有 ${many.length - MAX_REPORTED_CREDENTIAL_FILES} 个`)
  })

  it('干净的目录不会被误伤：.credentials.json 的隔壁照样共享得出去', () => {
    const project = makeDirectory('project', ['src/main.ts', 'notes/design.md'])

    expect(resolve([directoryEntry(project)]).mounts).toHaveLength(1)
  })

  it('.git 整个跳过：它能把上界打满，而里面不可能有凭据文件', () => {
    const repo = makeDirectory('repo', ['README.md'])
    // 造一个比上界还大的 .git。
    for (let index = 0; index < 30; index += 1) makeFile(`repo/.git/objects/${index}/obj`)
    writeFileSync(path.join(repo, '.git', 'config'), 'x\n')

    const { mounts, rejected } = resolve([directoryEntry(repo)], { maxScanEntries: 10 })

    expect(rejected).toEqual([])
    expect(mounts).toHaveLength(1)
  })

  it('扫描有上界：超了就报错让用户缩小范围，不许静默截断', () => {
    const big = makeDirectory('big', Array.from({ length: 40 }, (_, index) => `f${index}.md`))

    const { mounts, rejected } = resolve([directoryEntry(big)], { maxScanEntries: 10 })

    expect(mounts).toEqual([])
    expect(rejected[0]?.reason).toContain('10')
    expect(rejected[0]?.reason).toContain('请共享它下面更具体的子目录')
  })
})

describe('resolveSharedMounts · 不能当共享源的地方', () => {
  it('文件系统的根、宿主 home 本身、home 的上级，一个都不放', () => {
    expect(resolve([{ path: '/', kind: 'directory' }]).rejected[0]?.reason).toContain('文件系统的根')
    expect(resolve([directoryEntry(work)]).rejected[0]?.reason).toContain('本身')
    expect(resolve([directoryEntry(path.dirname(work))]).rejected[0]?.reason).toContain('上级')
  })

  it('主目录**下面**的子目录可以共享——这条口子是专门为共享开的', () => {
    // `/home` 在禁挂前缀里，而共享的目录本来就住在主目录下面。
    // 对配置文件那条规则是对的，对共享目录太宽了。
    const project = makeDirectory('projects/thing')

    expect(resolve([directoryEntry(project)]).mounts).toEqual([
      { source: project, target: '/shared/thing', mode: 'ro' },
    ])
  })

  it('主目录下那几处身份目录仍然拒绝（口子不往那儿开）', () => {
    const ssh = makeDirectory('.ssh', ['id_ed25519', 'known_hosts'])

    const reason = resolve([directoryEntry(ssh)]).rejected[0]?.reason ?? ''
    expect(reason).toContain('.ssh')
    expect(reason).toContain('身份')
  })

  it('禁挂前缀里的东西照样拒绝：/etc、/root、/var/run', () => {
    for (const source of ['/etc', '/root', '/var/run']) {
      const { mounts, rejected } = resolve([{ path: source, kind: 'directory' }])
      expect(mounts).toEqual([])
      expect(rejected[0]?.reason).toContain('禁挂前缀')
    }
  })

  it('docker socket 的父目录（/var/run）被拒', () => {
    // 这一条只有判**字面路径**才拦得住：/var/run 在多数 Linux 上是 /run 的软链，
    // 解析之后前缀名单里一个都对不上（见下一个用例）。
    const reason = resolve([directoryEntry('/var/run')]).rejected[0]?.reason ?? ''
    expect(reason).toContain('/var/run')
  })

  it('指向 /var/run 的链接也被拒——解析后落在 /run，那也是 docker socket 的父目录', () => {
    const link = path.join(work, 'run-like')
    symlinkSync('/var/run', link)

    const reason = resolve([directoryEntry(link)]).rejected[0]?.reason ?? ''
    expect(reason).toContain('禁挂前缀')
    expect(reason).toContain('/run')
  })

  it('和实例目录互斥：实例根的祖先与后代都不许当共享源', () => {
    // 就是默认布局：实例根在最里面，`~/.abx` 是它的祖先。
    const instancesRoot = path.join(work, '.abx', 'instances')
    mkdirSync(path.join(instancesRoot, 'claude', 'claude'), { recursive: true })

    const ancestor = resolve([directoryEntry(path.join(work, '.abx'))], { instancesRoot })
    const descendant = resolve([directoryEntry(path.join(instancesRoot, 'claude'))], { instancesRoot })

    expect(ancestor.mounts).toEqual([])
    expect(ancestor.rejected[0]?.reason).toContain('实例状态目录')
    expect(descendant.mounts).toEqual([])
    expect(descendant.rejected[0]?.reason).toContain('实例状态目录')
  })

  it('实例根这一格本身也拒绝', () => {
    const instancesRoot = path.join(work, '.abx', 'instances')
    mkdirSync(instancesRoot, { recursive: true })

    expect(resolve([directoryEntry(instancesRoot)], { instancesRoot }).mounts).toEqual([])
  })
})

describe('resolveSharedMounts · 符号链接', () => {
  it('链接指向敏感目录时按**目标**判定被拒，并在理由里说明是链接', () => {
    const link = path.join(work, 'innocent')
    symlinkSync('/etc', link)

    const reason = resolve([directoryEntry(link)]).rejected[0]?.reason ?? ''

    expect(reason).toContain('符号链接')
    expect(reason).toContain('禁挂前缀')
  })

  it('链接指向主目录外的 home 时不放行（链接不能用来绕前缀）', () => {
    const link = path.join(work, 'elsewhere')
    symlinkSync('/root', link)

    expect(resolve([directoryEntry(link)]).mounts).toEqual([])
  })

  it('链接指向合法目录时挂的是**解析后**的路径，不是链接本身', () => {
    const real = makeDirectory('real-notes', ['a.md'])
    const link = path.join(work, 'shortcut')
    symlinkSync(real, link)

    const { mounts, rejected } = resolve([directoryEntry(link)])

    expect(rejected).toEqual([])
    expect(mounts).toEqual([{ source: real, target: '/shared/real-notes', mode: 'ro' }])
  })

  it('悬空的链接被拒，理由仍然说明它是链接', () => {
    const link = path.join(work, 'dangling')
    symlinkSync(path.join(work, 'nowhere'), link)

    const reason = resolve([directoryEntry(link)]).rejected[0]?.reason ?? ''
    expect(reason).toContain('符号链接')
    expect(reason).toContain('找不到')
  })
})

describe('resolveSharedMounts · 全被拒的时候', () => {
  it('默认不抛：一条坏条目不该让会话起不来', () => {
    expect(() => resolve([directoryEntry(path.join(work, 'gone'))])).not.toThrow()
  })

  it('requireAtLeastOne 且一条都没挂上时才抛，理由里带上每一条的原因', () => {
    let thrown: unknown
    try {
      resolve([directoryEntry(path.join(work, 'gone'))], { requireAtLeastOne: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(MountPolicyViolation)
    expect((thrown as Error).message).toContain('gone')
    expect((thrown as Error).message).toContain('找不到')
  })

  it('requireAtLeastOne 但不为空时不抛', () => {
    const notes = makeDirectory('notes')
    expect(() => resolve([directoryEntry(notes)], { requireAtLeastOne: true })).not.toThrow()
  })
})
