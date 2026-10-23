/**
 * 挂载策略。
 *
 * 需求里写的是「任务目录挂载规则要写成代码里可读的策略对象，不要散落在各处」。
 * 这个文件就是那个对象：**一个**地方回答了「挂什么、以什么权限挂、什么绝对不许挂」，
 * 而且 `assertMountPolicy` 能在真正起容器之前把违规的组合拦下来。
 *
 * 为什么值得单独一个文件：挂载是这套隔离里最容易出事的一环，而且出事的方式全都
 * 悄无声息——多一行 `-v /home/user:/home/user`，容器里就能读到宿主的 SSH 私钥、
 * 云凭据、浏览器 cookie，而它在命令行里看起来跟别的参数没有任何区别。
 *
 * 两条规则要分清楚，它们的严格程度不一样：
 *   - **任务目录**是用户显式选的，可以是 `/home/me/project` 这种路径。只有一个约束：
 *     它不能是某个危险目录本身（不能直接拿 `/home` 或 `/` 当任务目录）。
 *   - **额外挂载**一律不许。所以除任务目录外的任何宿主路径，只要落在禁挂前缀里，
 *     或者压根不是任务目录，都会被拒。
 */

import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { SandboxMount } from './backend'

/**
 * 禁挂前缀：任何挂载源落在这下面都不行。
 *
 * 每一条都对应一类具体的逃逸：
 *   - `/home` `/root`：SSH 私钥、`~/.aws`、`~/.config/gh`、浏览器数据；
 *   - `/etc`：`/etc/passwd`、`/etc/shadow`、各种服务凭据；
 *   - `/var/run`：**docker socket 就在这里**。挂进去等于把宿主 root 交出去；
 *   - `/proc` `/sys` `/dev`：内核接口，容器逃逸的经典入口。
 */
export const FORBIDDEN_MOUNT_PREFIXES: readonly string[] = [
  '/home',
  '/root',
  '/etc',
  '/var/run',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
]

/** 单独点名：它比整个 `/var/run` 更值得在报错里被写出来。 */
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock'

/**
 * 不能**作为任务目录本身**的路径。
 *
 * 比禁挂前缀短：`/home/me/project` 是正常的任务目录，`/home` 不是。
 */
export const DANGEROUS_TASK_DIRS: readonly string[] = [
  '/',
  '/home',
  '/root',
  '/etc',
  '/usr',
  '/var',
  '/var/run',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
]

export interface MountPolicyRule {
  readonly requirement: string
  readonly rationale: string
}

export interface MountPolicy {
  readonly summary: string
  readonly rules: readonly MountPolicyRule[]
  readonly forbiddenMountPrefixes: readonly string[]
  readonly dangerousTaskDirs: readonly string[]
  /** 任务目录是不是可写。 */
  readonly taskDirMode: 'rw'
  /** 除任务目录外，宿主的任何东西都不进舱内。 */
  readonly mountsHostHome: false
  buildMounts(taskDir: string, workdir: string): readonly SandboxMount[]
}

export const MOUNT_POLICY: MountPolicy = {
  summary: '只把任务目录以可写方式挂进舱内；宿主上的其他一切都不挂。',
  taskDirMode: 'rw',
  mountsHostHome: false,
  forbiddenMountPrefixes: FORBIDDEN_MOUNT_PREFIXES,
  dangerousTaskDirs: DANGEROUS_TASK_DIRS,
  rules: [
    {
      requirement: '任务目录以 rw 挂载，且是唯一一个挂载点',
      rationale: 'agent 要在里面干活；除此之外舱内不应该有任何能碰回宿主的地方。',
    },
    {
      requirement: '不挂载用户主目录，不挂载 /home',
      rationale: 'SSH 私钥、云凭据、浏览器数据都在那里。一次挂载就等于全部交出去。',
    },
    {
      requirement: '不挂载 docker socket',
      rationale: '挂进去之后容器里就能指挥宿主上的 docker，隔离直接归零。',
    },
    {
      requirement: '除任务目录外不接受任何宿主路径',
      rationale: '需要读别的东西时，正确做法是复制进任务目录，而不是再开一个挂载点。',
    },
  ],
  buildMounts(taskDir: string, workdir: string): readonly SandboxMount[] {
    return [{ source: path.resolve(taskDir), target: workdir, mode: 'rw' }]
  },
}

export class MountPolicyViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MountPolicyViolation'
  }
}

/** 这个宿主路径能不能作为挂载源。 */
export function isForbiddenMountSource(source: string): boolean {
  if (source === DOCKER_SOCKET_PATH) return true
  return FORBIDDEN_MOUNT_PREFIXES.some(
    (prefix) => source === prefix || source.startsWith(`${prefix}${path.sep}`),
  )
}

export interface AssertMountPolicyInput {
  readonly mounts: readonly SandboxMount[]
  readonly taskDir: string
  readonly workdir: string
}

/**
 * 起容器之前把挂载清单过一遍。违反任何一条就抛。
 *
 * 会在这里抛而不是打个警告，是因为这些组合没有一种是「配置写错了但还是能跑」——
 * 它们全都是「跑起来了，但隔离没了」。
 *
 * 检查顺序是先看有没有禁挂路径，再看结构。理由很实际：一个同时犯了两个错的配置，
 * 用户最需要看到的是「你挂到 /home 去了」，而不是「挂载点数量不对」。
 */
export function assertMountPolicy(input: AssertMountPolicyInput): void {
  const taskDir = path.resolve(input.taskDir)
  const { mounts, workdir } = input

  for (const mount of mounts) {
    if (!path.isAbsolute(mount.source) || !path.isAbsolute(mount.target)) {
      throw new MountPolicyViolation(`挂载必须用绝对路径：${mount.source} → ${mount.target}`)
    }

    // `..` 能把一个看起来人畜无害的路径变成 `/home`。
    if (mount.source.split(path.sep).includes('..')) {
      throw new MountPolicyViolation(`挂载路径里不允许出现 ..：${mount.source}`)
    }

    // 任务目录由用户显式指定，豁免前缀规则；其余的挂载源一个都不放过。
    if (mount.source !== taskDir && isForbiddenMountSource(mount.source)) {
      // docker socket 单独给一句话：它是最容易被顺手挂进去、后果也最严重的一个
      // （挂进去等于把宿主 root 交出去），值得在报错里被点名。
      if (mount.source === DOCKER_SOCKET_PATH) {
        throw new MountPolicyViolation(
          `拒绝挂载 docker socket（${DOCKER_SOCKET_PATH}）：舱内能指挥宿主 docker 就等于没有隔离。` +
            `需要构建镜像时，请在宿主机上手动构建。`,
        )
      }
      throw new MountPolicyViolation(
        `拒绝挂载 ${mount.source}：除任务目录外，宿主路径一律不进舱内。` +
          `需要里面的文件时请复制到任务目录，而不是开一个挂载点。`,
      )
    }
  }

  const writable = mounts.filter((mount) => mount.mode === 'rw')
  if (writable.length > 1) {
    throw new MountPolicyViolation(
      `只允许一个可写挂载（任务目录），实际有 ${writable.length} 个：${writable
        .map((mount) => mount.source)
        .join(', ')}`,
    )
  }

  if (DANGEROUS_TASK_DIRS.includes(taskDir)) {
    throw new MountPolicyViolation(
      `拒绝把 ${taskDir} 作为任务目录：它本身就是一个敏感位置。请指向具体项目目录。`,
    )
  }

  for (const mount of mounts) {
    if (mount.source !== taskDir) {
      throw new MountPolicyViolation(`除任务目录 ${taskDir} 外不允许有别的挂载源，实际是 ${mount.source}`)
    }
    if (mount.target !== workdir) {
      throw new MountPolicyViolation(`除工作目录 ${workdir} 外不允许有别的挂载点，实际是 ${mount.target}`)
    }
  }
}

/**
 * 顺带一眼：宿主上这个任务目录里有没有明显不该带进舱内的东西。
 *
 * 这不是拦截，是提示。任务目录是用户自己选的，里面放什么是他的自由；
 * 但如果 `.env` 或 `.git-credentials` 正好在里面，值得在启动前说一声——
 * 舱内那个 agent 拿到的是**可写**权限，改坏了是回不来的。
 */
export function findRiskyFilesInTaskDir(taskDir: string): readonly string[] {
  const candidates = ['.env', '.git-credentials', '.netrc', 'id_rsa', 'id_ed25519', '.npmrc', '.pypirc']
  const found: string[] = []

  for (const name of candidates) {
    try {
      readFileSync(path.join(taskDir, name))
      found.push(name)
    } catch {
      // 不存在就是不存在，这是常态。
    }
  }

  return found
}
