/**
 * docker 后端的用例。
 *
 * 本机 docker 守护进程没起来，所以这里**不**起真容器。它验证的是命令行参数——
 * 也就是「到底挂了什么、开了什么权限、注入了什么」。这恰恰是 docker 后端里
 * 最该被钉死的部分：一个多出来的 `--volume` 或者少掉的 `--cap-drop`，
 * 靠跑一次容器是看不出来的，靠断言 argv 是一眼就能看出来的。
 *
 * 「真容器能不能起来」这件事没验证，如实写在 docs/PHASE1-REPORT.md 里。
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_SHIM_CELL_PATH, MCP_SHIM_FILE_NAME, agentConfigFileNames } from '@abx/contracts'
import type { SandboxSpec } from './backend'
import { buildDockerArgs, containerName, isExecutableOnPath } from './docker-backend'
import { MOUNT_POLICY } from './mount-policy'

const TASK_DIR = '/home/dev/projects/thing'

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    cellId: 'claude-20261023-ab12cd',
    agentId: 'claude',
    command: ['claude'],
    allocateTty: true,
    taskDir: TASK_DIR,
    workdir: '/workspace',
    cellHome: '/home/node',
    env: { ANTHROPIC_AUTH_TOKEN: 'abx-placeholder-anthropic', ANTHROPIC_BASE_URL: 'http://172.17.0.1:8789/u/anthropic' },
    forbiddenEnvNames: ['ANTHROPIC_API_KEY'],
    limits: { memory: '2g', pids: 256, cpus: 2 },
    image: 'node:22-slim',
    user: '1000:1000',
    network: 'bridge',
    tmpfsSizeMb: 64,
    ...overrides,
  }
}

function argsFor(overrides: Partial<SandboxSpec> = {}): readonly string[] {
  const current = spec(overrides)
  return buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir))
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function allFlagValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = []
  args.forEach((arg, index) => {
    if (arg === flag) {
      const value = args[index + 1]
      if (value !== undefined) values.push(value)
    }
  })
  return values
}

describe('buildDockerArgs', () => {
  it('一次性容器：--rm', () => {
    expect(argsFor()).toContain('--rm')
  })

  it('只挂任务目录，且可写', () => {
    const volumes = allFlagValues(argsFor(), '--volume')
    expect(volumes).toEqual([`${TASK_DIR}:/workspace:rw`])
  })

  it('绝不挂载主目录、/home、docker socket', () => {
    const volumes = allFlagValues(argsFor(), '--volume')
    expect(volumes.some((volume) => volume.includes('/home/dev:'))).toBe(false)
    expect(volumes.some((volume) => volume.startsWith('/home:'))).toBe(false)
    expect(volumes.some((volume) => volume.includes('docker.sock'))).toBe(false)
    expect(volumes).toHaveLength(1)
  })

  it('非 root 运行', () => {
    expect(flagValue(argsFor(), '--user')).toBe('1000:1000')
    expect(flagValue(argsFor(), '--user')).not.toBe('root')
    expect(flagValue(argsFor(), '--user')).not.toBe('0')
  })

  it('资源限额三项都在', () => {
    expect(flagValue(argsFor(), '--memory')).toBe('2g')
    expect(flagValue(argsFor(), '--pids-limit')).toBe('256')
    expect(flagValue(argsFor(), '--cpus')).toBe('2')
  })

  it('限额跟着配置走', () => {
    const args = argsFor({ limits: { memory: '512m', pids: 64, cpus: 0.5 } })
    expect(flagValue(args, '--memory')).toBe('512m')
    expect(flagValue(args, '--pids-limit')).toBe('64')
    expect(flagValue(args, '--cpus')).toBe('0.5')
  })

  it('丢掉所有 capability，并禁止提权', () => {
    expect(flagValue(argsFor(), '--cap-drop')).toBe('ALL')
    expect(flagValue(argsFor(), '--security-opt')).toBe('no-new-privileges')
  })

  it('根文件系统只读，/tmp 走 tmpfs', () => {
    const args = argsFor()
    expect(args).toContain('--read-only')
    expect(flagValue(args, '--tmpfs')).toBe('/tmp:rw,noexec,nosuid,size=64m')
  })

  it('带上 --init，僵尸进程不会堆在容器里', () => {
    expect(argsFor()).toContain('--init')
  })

  it('不申请特权模式', () => {
    const args = argsFor()
    expect(args).not.toContain('--privileged')
    expect(args).not.toContain('--pid=host')
    expect(args.some((arg) => arg.includes('--network=host'))).toBe(false)
  })

  it('调用方有终端时分配 TTY', () => {
    expect(argsFor({ allocateTty: true })).toContain('--tty')
    // 默认就是交互态，避免以后有人在 spec() 里改掉默认值而把「有终端」测丢。
    expect(argsFor()).toContain('--tty')
  })

  it('调用方没有终端时不带 --tty，但 --interactive 仍然在', () => {
    // 托盘（管道 spawn）、CI、脚本都没有终端。带上 --tty 时 docker 会直接
    // 拒绝起容器：cannot attach stdin to a TTY-enabled container because
    // stdin is not a terminal——不是降级，是起不来。
    const args = argsFor({ allocateTty: false })
    expect(args).not.toContain('--tty')
    expect(args).toContain('--interactive')
  })

  it('舱内 home 显式注入，不依赖镜像默认值', () => {
    // agent 把会话历史写到 `$HOME/.claude/...`，而实例状态目录挂在 cellHome 下面。
    // 两个值分家 = 往一个没挂载的路径写历史 = 历史照丢，且命令行里看不出来。
    expect(allFlagValues(argsFor(), '--env')).toContain('HOME=/home/node')
    expect(allFlagValues(argsFor({ cellHome: '/home/other' }), '--env')).toContain('HOME=/home/other')
  })

  it('环境变量以 --env 注入，且不含被点名禁用的名字', () => {
    const envs = allFlagValues(argsFor(), '--env')
    expect(envs).toEqual([
      'HOME=/home/node',
      'ANTHROPIC_AUTH_TOKEN=abx-placeholder-anthropic',
      'ANTHROPIC_BASE_URL=http://172.17.0.1:8789/u/anthropic',
    ])
    expect(envs.some((entry) => entry.startsWith('ANTHROPIC_API_KEY='))).toBe(false)
  })

  it('环境变量顺序稳定，同一份配置两次结果一致', () => {
    // 不排序的话每次 argv 顺序都不一样，测试和 diff 都没法看。
    expect(argsFor()).toEqual(argsFor())
  })

  it('工作目录和镜像接在最后，后面跟命令', () => {
    const args = argsFor({ command: ['claude', '--verbose'] })
    const imageIndex = args.indexOf('node:22-slim')
    expect(args.slice(imageIndex)).toEqual(['node:22-slim', 'claude', '--verbose'])
  })

  it('容器带标签，方便事后认领', () => {
    const labels = allFlagValues(argsFor(), '--label')
    expect(labels).toContain('abx.cell-id=claude-20261023-ab12cd')
    expect(labels).toContain('abx.agent=claude')
  })
})

describe('生成的 agent 配置：逐个文件、只读', async () => {
  const { createDockerBackend } = await import('./docker-backend')
  const SETTINGS = {
    hostPath: '/home/dev/.abx/cells/claude-1/agents/claude/settings.json',
    cellPath: '/home/dev/.claude/settings.json',
  }
  const CODEX_CONFIG = {
    hostPath: '/home/dev/.abx/cells/claude-1/agents/codex/config.toml',
    cellPath: '/home/dev/.codex/config.toml',
  }

  function configArgs(files = [SETTINGS]): readonly string[] {
    const current = spec({ agentConfigFiles: files })
    return buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir, files))
  }

  it('一个文件一个 -v，全部 :ro，任务目录仍是唯一可写的那一个', () => {
    expect(allFlagValues(configArgs([SETTINGS, CODEX_CONFIG]), '--volume')).toEqual([
      `${TASK_DIR}:/workspace:rw`,
      `${SETTINGS.hostPath}:${SETTINGS.cellPath}:ro`,
      `${CODEX_CONFIG.hostPath}:${CODEX_CONFIG.cellPath}:ro`,
    ])
  })

  it('没有一条挂载是目录形态——目录里躺着凭据文件', () => {
    for (const volume of allFlagValues(configArgs([SETTINGS, CODEX_CONFIG]), '--volume').slice(1)) {
      const [source, , mode] = volume.split(':')
      expect(mode).toBe('ro')
      // 源的 basename 必须是注册过的配置文件名。目录形态（`…/agents/claude`）
      // 在这里露馅：它没有任何一个配置文件名。
      expect(agentConfigFileNames()).toContain(path.basename(source!))
      expect(volume).not.toContain(':/home/dev/.claude:')
      expect(volume).not.toContain(':/home/dev/.codex:')
    }
  })

  it('每一份配置各自一个挂载点，不会合并成父目录', () => {
    const volumes = allFlagValues(configArgs([SETTINGS, CODEX_CONFIG]), '--volume')
    expect(volumes).toHaveLength(3)
    expect(volumes.every((volume) => !volume.startsWith('/home/dev/.abx/cells/claude-1/agents:'))).toBe(true)
  })

  it('没有配置时行为不变，仍然只挂任务目录', () => {
    expect(allFlagValues(configArgs([]), '--volume')).toEqual([`${TASK_DIR}:/workspace:rw`])
  })

  it('凭据文件混进配置清单时，起容器之前就被拒', async () => {
    let spawned = false
    const backend = createDockerBackend({
      spawnProcess: (() => {
        spawned = true
        return new EventEmitter()
      }) as never,
    })
    const credential = {
      hostPath: '/home/dev/.abx/cells/claude-1/agents/claude/.credentials.json',
      cellPath: '/home/dev/.claude/.credentials.json',
    }

    await expect(
      backend.create(spec({ agentConfigFiles: [credential] }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow(/凭据文件/)
    expect(spawned).toBe(false)
  })
})

describe('实例状态目录：第二个可写挂载，配置嵌在它里面', async () => {
  const { createDockerBackend } = await import('./docker-backend')

  const tempDirs: string[] = []

  afterEach(() => {
    for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
    tempDirs.length = 0
  })

  /** 一个真实存在的实例状态目录。策略那边是**失败关闭**的，所以必须真的建出来。 */
  function stateDirFixture(instanceId = 'claude', agentId = 'claude') {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-docker-')))
    tempDirs.push(base)
    const instancesRoot = path.join(base, 'instances')
    const hostPath = path.join(instancesRoot, instanceId, agentId)
    mkdirSync(hostPath, { recursive: true })
    return { base, instancesRoot, stateDir: { hostPath, cellPath: `/home/node/.${agentId}`, agentId } }
  }

  it('目录以 rw 挂进去，同一个目录里的配置那一格以 ro 盖在上面', async () => {
    // 这是真实形态：配置**长在**实例目录里，所以它落在可写挂载内部。
    // docker 的嵌套绑定是「深的目标赢」，两个挂载点必须同时在 argv 里。
    const { stateDir } = stateDirFixture()
    const settings = { hostPath: path.join(stateDir.hostPath, 'settings.json'), cellPath: `${stateDir.cellPath}/settings.json` }

    const current = spec({ agentConfigFiles: [settings], stateDirs: [stateDir] })
    const volumes = allFlagValues(buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir, [settings], [stateDir])), '--volume')

    expect(volumes).toEqual([
      `${TASK_DIR}:/workspace:rw`,
      `${stateDir.hostPath}:${stateDir.cellPath}:rw`,
      `${settings.hostPath}:${settings.cellPath}:ro`,
    ])
    // 状态目录的挂载点必须在配置挂载点的**前面**，否则「深的目标赢」这条规则
    // 就依赖于 docker 的实现细节而不是顺序。断言顺序比断言集合更安全。
    expect(volumes.indexOf(`${stateDir.hostPath}:${stateDir.cellPath}:rw`)).toBeLessThan(
      volumes.indexOf(`${settings.hostPath}:${settings.cellPath}:ro`),
    )
  })

  it('起容器前过闸：拿宿主真实的 ~/.claude 当状态目录源，spawn 都不会发生', async () => {
    let spawned = false
    const backend = createDockerBackend({
      spawnProcess: (() => {
        spawned = true
        return new EventEmitter()
      }) as never,
    })
    const hostClaude = { hostPath: path.join(homedir(), '.claude'), cellPath: '/home/node/.claude', agentId: 'claude' }

    await expect(
      backend.create(spec({ stateDirs: [hostClaude] }), { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined }),
    ).rejects.toThrow(/不在实例根/)
    expect(spawned).toBe(false)
  })
})

describe('共享条目：只读挂进 /shared，且不计入可写', () => {
  it('每一条共享条目就是一条 --volume，权限是 ro', () => {
    const shared = [
      { source: '/home/dev/projects/notes', target: '/shared/notes', mode: 'ro' as const },
      { source: '/home/dev/data', target: '/shared/data', mode: 'ro' as const },
    ]
    const current = spec({ sharedMounts: shared })
    const volumes = allFlagValues(
      buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir, [], [], shared)),
      '--volume',
    )

    expect(volumes).toEqual([
      `${TASK_DIR}:/workspace:rw`,
      '/home/dev/projects/notes:/shared/notes:ro',
      '/home/dev/data:/shared/data:ro',
    ])
    // 可写挂载仍然只有任务目录一个：共享是只读的，不该占可写的额度。
    expect(volumes.filter((volume) => volume.endsWith(':rw'))).toEqual([`${TASK_DIR}:/workspace:rw`])
  })

  it('目录共享就是一条挂载——1000 个文件也是这一条', () => {
    // 这条断言防的是「递归展开成单文件挂载」那种改法：它会让 argv 的体积跟着
    // 目录内容走，而且目录里新增的文件从此不再出现。
    const shared = [{ source: '/home/dev/projects/notes', target: '/shared/notes', mode: 'ro' as const }]
    const current = spec({ sharedMounts: shared })

    const args = buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir, [], [], shared))
    expect(allFlagValues(args, '--volume')).toHaveLength(2)
  })
})

describe('containerName', () => {
  it('加前缀，便于一眼认出是气闸起的', () => {
    expect(containerName('claude-1')).toBe('abx-claude-1')
  })

  it('非法字符被替换，否则 docker 会直接拒绝这个名字', () => {
    expect(containerName('a/b c:d')).toBe('abx-a-b-c-d')
  })

  it('结果符合 docker 的命名规则', () => {
    expect(containerName('claude-2026/x')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  })
})

describe('isExecutableOnPath', () => {
  it('绝对路径直接查文件是否存在且可执行', () => {
    expect(isExecutableOnPath('/bin/sh')).toBe(true)
    expect(isExecutableOnPath('/definitely/not/here')).toBe(false)
  })

  it('PATH 上的命令能查到', () => {
    expect(isExecutableOnPath('sh')).toBe(true)
  })

  it('不存在的命令查不到', () => {
    expect(isExecutableOnPath('abx-definitely-not-a-command')).toBe(false)
  })
})

describe('后端契约', async () => {
  const { createDockerBackend } = await import('./docker-backend')

  it('声明自己是真沙箱', () => {
    const backend = createDockerBackend()
    expect(backend.id).toBe('docker')
    expect(backend.isRealSandbox).toBe(true)
    expect(backend.warning).toBeNull()
  })

  it('凭据变量混进 env 时拒绝启动，且不走到 spawn', async () => {
    let spawned = false
    const backend = createDockerBackend({
      spawnProcess: (() => {
        spawned = true
        return new EventEmitter()
      }) as never,
    })

    await expect(
      backend.create(spec({ env: { ANTHROPIC_API_KEY: 'sk-ant-real' } }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow(/不能注入舱内/)
    expect(spawned).toBe(false)
  })

  it('错误信息里报变量名，不报值', async () => {
    const backend = createDockerBackend({ spawnProcess: (() => new EventEmitter()) as never })
    const error = await backend
      .create(spec({ env: { ANTHROPIC_API_KEY: 'sk-ant-super-secret' } }), {
        mode: 'pipe',
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
      .then(
        () => null,
        (reason: Error) => reason,
      )

    expect(error).not.toBeNull()
    expect(error?.message).toContain('ANTHROPIC_API_KEY')
    expect(error?.message).not.toContain('sk-ant-super-secret')
  })

  it('docker 起不来时给一句能照着做的提示', async () => {
    const backend = createDockerBackend({
      spawnProcess: (() => {
        const child = new EventEmitter()
        // spawn 失败是异步发 error 事件，不是同步抛。
        setImmediate(() => child.emit('error', new Error('ENOENT')))
        return child as never
      }) as never,
    })

    const handle = await backend.create(spec(), { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined })
    await expect(handle.exit).rejects.toThrow(/abx doctor/)
  })
})

describe('运行时文件：一个只读文件挂到固定的落点', async () => {
  const { createDockerBackend } = await import('./docker-backend')

  const tempDirs: string[] = []

  afterEach(() => {
    for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
    tempDirs.length = 0
  })

  /** 真的写一份出来：闸门要求来源是个存在的文件。 */
  function shimFixture(cellId = 'claude-20261023-ab12cd') {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'abx-docker-rt-')))
    tempDirs.push(base)
    const runtimeRoot = path.join(base, 'runtime')
    const directory = path.join(runtimeRoot, cellId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, MCP_SHIM_FILE_NAME), '// abx shim\n')
    const file = { hostPath: path.join(directory, MCP_SHIM_FILE_NAME), cellPath: MCP_SHIM_CELL_PATH }
    return { runtimeRoot, file }
  }

  it('一条 -v，:ro，落点是那个写死的舱内路径，可写的仍然只有任务目录', () => {
    const { file } = shimFixture()
    const current = spec({ runtimeFiles: [file] })
    const volumes = allFlagValues(
      buildDockerArgs(current, MOUNT_POLICY.buildMounts(current.taskDir, current.workdir, [], [], [], [file])),
      '--volume',
    )

    expect(volumes).toEqual([`${TASK_DIR}:/workspace:rw`, `${file.hostPath}:${MCP_SHIM_CELL_PATH}:ro`])
    expect(volumes.filter((volume) => volume.endsWith(':rw'))).toEqual([`${TASK_DIR}:/workspace:rw`])
  })

  it('来源换成一个同名的假文件时，起容器之前就被拒：spawn 都不会发生', async () => {
    let spawned = false
    const backend = createDockerBackend({
      spawnProcess: (() => {
        spawned = true
        return new EventEmitter()
      }) as never,
    })
    const planted = { hostPath: path.join(homedir(), '.ssh', MCP_SHIM_FILE_NAME), cellPath: MCP_SHIM_CELL_PATH }

    await expect(
      backend.create(spec({ runtimeFiles: [planted] }), { mode: 'pipe', onStdout: () => undefined, onStderr: () => undefined }),
    ).rejects.toThrow(/不在运行时根|不是一个存在的文件/)
    expect(spawned).toBe(false)
  })
})
