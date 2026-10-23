/**
 * 实例目录的用例。
 *
 * 这里钉的是「路径算得对」和「目录建得对」——不涉及挂载策略（那组在
 * `mount-policy.test.ts`）也不涉及 open 的接线（那组在 `open.test.ts`）。
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAgent, AGENT_DEFINITIONS } from '@abx/contracts'
import { RUNNING_PLATFORM, RUNNING_VOCABULARY } from '../test-support'
import { agentHomePath } from './agent-config'
import {
  INSTANCES_ROOT_ENV,
  InstanceError,
  appendSessionRecord,
  defaultInstancesRoot,
  ensureInstanceStateDir,
  isValidInstanceId,
  planInstance,
} from './instance'

/**
 * **舱内** home。它永远是容器里的路径，所以写死 POSIX 形状是对的——
 * 跟跑测试这台机器是什么系统无关（见 `cell-path.ts`）。
 */
const HOME = '/home/dev'
/** 宿主那边的路径按跑测试这台机器造：实例根是宿主路径。 */
const HOST = RUNNING_VOCABULARY
const INSTANCES_ROOT = HOST.underHome('.abx', 'instances')

interface PlanOverrides {
  readonly cellHome?: string
  readonly instancesRoot?: string
}

function plan(agentId: string, instanceId: string, overrides: PlanOverrides = {}) {
  const agent = findAgent(agentId)
  if (agent === null) throw new Error(`测试里写了不存在的 agent：${agentId}`)
  return planInstance({
    agent,
    instanceId,
    cellHome: HOME,
    instancesRoot: INSTANCES_ROOT,
    ...overrides,
  })
}

describe('defaultInstancesRoot', () => {
  it('默认落在 ~/.abx/instances', () => {
    expect(defaultInstancesRoot({}, HOME)).toBe(path.join(HOME, '.abx', 'instances'))
  })

  it('环境变量能覆盖它，并解析成绝对路径', () => {
    const override = HOST.join(HOST.outsideDir, 'instances')
    expect(defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: override }, HOME)).toBe(override)
    expect(defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: 'relative/dir' }, HOME)).toBe(path.resolve('relative/dir'))
  })

  it('空串和只有空白当作没设——不然路径会变成一个空的根', () => {
    expect(defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: '' }, HOME)).toBe(path.join(HOME, '.abx', 'instances'))
    expect(defaultInstancesRoot({ [INSTANCES_ROOT_ENV]: '   ' }, HOME)).toBe(path.join(HOME, '.abx', 'instances'))
  })
})

describe('isValidInstanceId', () => {
  it('普通的 id 都合法', () => {
    for (const id of ['claude', 'codex', 'dsh', 'my-project', 'work_1', 'a.b']) {
      expect(isValidInstanceId(id)).toBe(true)
    }
  })

  it('拿不出目录名的写法一律不合法', () => {
    for (const id of ['', ' ', '.', '..', '../etc', 'a/b', '/abs', '-leading', '.hidden-ish', 'a b', 'a\tb']) {
      expect(isValidInstanceId(id)).toBe(false)
    }
  })
})

describe('planInstance', () => {
  it('默认实例就是 agent 自己：再开一次 claude 接着上一次往下写', () => {
    // 这条是「按实例而不是按 cell 落盘」的全部要点：同一个 agent 的两次运行
    // 必须落在同一个目录里，否则历史还是接不上。
    const first = plan('claude', 'claude')
    const second = plan('claude', 'claude')
    expect(first.stateDir).toBe(second.stateDir)
    expect(first.stateDir).toBe(HOST.join(INSTANCES_ROOT, 'claude', 'claude'))
  })

  it('实例根下每个实例一个目录，每个 agent 在实例里一个子目录', () => {
    expect(plan('claude', 'work').stateDir).toBe(HOST.join(INSTANCES_ROOT, 'work', 'claude'))
    expect(plan('codex', 'work').stateDir).toBe(HOST.join(INSTANCES_ROOT, 'work', 'codex'))
    expect(plan('claude', 'home').stateDir).toBe(HOST.join(INSTANCES_ROOT, 'home', 'claude'))
  })

  it('舱内挂载点就是 agent 的舱内主目录', () => {
    expect(plan('claude', 'claude').cellPath).toBe(`${HOME}/.claude`)
    expect(plan('codex', 'codex').cellPath).toBe(`${HOME}/.codex`)
    expect(plan('dsh', 'dsh').cellPath).toBe(`${HOME}/.dsh`)
  })

  it('流水写在实例根下，不在任何挂载点里', () => {
    // 挂进舱的是 `<root>/<agentId>`；`sessions.jsonl` 在它外面一层，
    // 所以舱内看不到它——这是「只在宿主写」的实现方式。
    const current = plan('claude', 'claude')
    expect(current.sessionLogPath).toBe(HOST.join(INSTANCES_ROOT, 'claude', 'sessions.jsonl'))
    expect(current.sessionLogPath.startsWith(`${current.stateDir}${HOST.rules.path.sep}`)).toBe(false)
  })

  it('cellHome 换了，挂载点跟着换', () => {
    expect(plan('claude', 'claude', { cellHome: '/home/other' }).cellPath).toBe('/home/other/.claude')
  })

  it('非法实例 id 直接抛，不静默改写', () => {
    // 静默 basename 的话，`../../etc` 会变成 `etc`，用户以为自己开了别的实例。
    expect(() => plan('claude', '../../etc')).toThrow(InstanceError)
    expect(() => plan('claude', 'a/b')).toThrow(InstanceError)
  })

  it('每个 agent 的舱内主目录都推得出来', () => {
    for (const agent of AGENT_DEFINITIONS) {
      expect(agentHomePath(agent, HOME)).toBe(`${HOME}/.${agent.id}`)
    }
  })
})

describe('ensureInstanceStateDir', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  function tempRoot(): string {
    // realpath：`ensureInstanceStateDir` 返回的是解析过软链的路径，而 Windows 上的
    // `%TEMP%` 可能是 8.3 短名（`C:\Users\RUNNER~1\...`）。不先归一，
    // 「字面路径 === realpath」这条断言在 Windows 上会因为一个与本题无关的原因红。
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-instances-')))
    directories.push(directory)
    return directory
  }

  it('目录不存在就建出来，权限 0700——里面是会话历史', () => {
    const root = tempRoot()
    const current = plan('claude', 'claude', { instancesRoot: root })
    const resolved = ensureInstanceStateDir(current)

    expect(resolved).toBe(current.stateDir)
    expect(statSync(current.stateDir).isDirectory()).toBe(true)
    if (RUNNING_PLATFORM === 'win32') {
      // Windows 上没有 POSIX 权限位，`mode` 里只剩「只读」那一位（`statSync` 给的
      // 是合成值，写死数字等于在断言 Node 的内部实现）。能验的是同一件事的另一半：
      // 这个目录**不是只读的**——历史要写得进去。0o700 那种位在那边根本不存在。
      expect(statSync(current.stateDir).mode & 0o200).not.toBe(0)
    } else {
      expect(statSync(current.stateDir).mode & 0o777).toBe(0o700)
    }
  })

  it('重复调用不抛——同一个实例本来就会被反复打开', () => {
    const current = plan('claude', 'claude', { instancesRoot: tempRoot() })
    ensureInstanceStateDir(current)
    expect(() => ensureInstanceStateDir(current)).not.toThrow()
  })

  it('返回的是 realpath：调用方要拿它去过「软链有没有逃出去」那道闸', () => {
    const root = tempRoot()
    // 实例根本身是软链（macOS 上 `/tmp` → `/private/tmp` 就是这种情形）。
    // 这是正常的，不该被误判成逃逸——所以策略那边比的是 realpath 对 realpath。
    symlinkSync(root, path.join(root, 'link'), 'dir')
    const current = plan('claude', 'claude', { instancesRoot: path.join(root, 'link') })

    expect(ensureInstanceStateDir(current)).toBe(realpathSync(path.join(root, 'claude', 'claude')))
  })
})

describe('appendSessionRecord', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  function logPath(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'abx-instances-'))
    directories.push(directory)
    return path.join(directory, 'claude', 'sessions.jsonl')
  }

  it('一行一条 JSON，父目录不存在也会建', () => {
    const file = logPath()
    appendSessionRecord(file, {
      instanceId: 'claude',
      cellId: 'claude-1',
      agentId: 'claude',
      backend: 'docker',
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:05:00.000Z',
      exitCode: 0,
      signal: null,
    })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      instanceId: 'claude',
      cellId: 'claude-1',
      agentId: 'claude',
      backend: 'docker',
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:05:00.000Z',
      exitCode: 0,
      signal: null,
    })
  })

  it('是追加不是重写：上一次的记录还在', () => {
    const file = logPath()
    const base = {
      instanceId: 'claude',
      agentId: 'claude',
      backend: 'docker',
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:05:00.000Z',
      exitCode: 0,
      signal: null,
    }
    appendSessionRecord(file, { ...base, cellId: 'claude-1' })
    appendSessionRecord(file, { ...base, cellId: 'claude-2' })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).cellId)).toEqual(['claude-1', 'claude-2'])
  })

  it('退出码未知（信号终止）时如实写 null，不写 0', () => {
    const file = logPath()
    appendSessionRecord(file, {
      instanceId: 'claude',
      cellId: 'claude-1',
      agentId: 'claude',
      backend: 'docker',
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:05:00.000Z',
      exitCode: null,
      signal: 'SIGTERM',
    })
    const record = JSON.parse(readFileSync(file, 'utf8').trim())
    expect(record.exitCode).toBeNull()
    expect(record.signal).toBe('SIGTERM')
  })
})
