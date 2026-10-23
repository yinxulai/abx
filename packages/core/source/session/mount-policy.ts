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
 * **可写的只有两类**，其余一律不挂或者只读：
 *   - **任务目录**是用户显式选的，可以是 `/home/me/project` 这种路径。只有一个约束：
 *     它不能是某个危险目录本身（不能直接拿 `/home` 或 `/` 当任务目录）。
 *   - **实例状态目录**（`~/.abx/instances/<instanceId>/<agentId>`）是「历史跨会话
 *     活下来」的实现方式，见 `instance.ts`。它比任务目录危险得多——任务目录是用户
 *     自己指的一个项目目录，而状态目录**默认落在主目录下面**，所以它有专门几道闸
 *     （`assertStateDirPolicy`）：必须在实例根之下、realpath 之后不得逃逸、
 *     不得是宿主 home、不得命中凭据文件名。
 *   - **额外挂载**一律不许。除这两类以外的任何宿主路径都会被拒。
 *
 * 还有一类规则拦的是**单个文件**：凭据文件名黑名单（`FORBIDDEN_CREDENTIAL_FILE_PATTERNS`）。
 * 前缀名单拦不了它——`~/.claude/.credentials.json` 与 `~/.claude/settings.json`
 * 在同一个目录里，而后者正是我们要挂进去的配置。所以「不许挂目录」不是洁癖，
 * 是这两个东西必须分开对待的唯一办法。
 */

import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { agentConfigFileNames } from '@abx/contracts'
import type { SandboxConfigFile, SandboxMount, SandboxStateDir } from './backend'
import { defaultInstancesRoot } from './instance'

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
 * 舱内共享区的根：用户拖进来的东西一律挂在 `/shared/<名字>` 下，只读。
 *
 * 挂载点由 `resolveSharedMounts()` 算，不由调用方给——它是这套东西里唯一
 * 「可以多出来几个」的挂载类别，位置再随便给就没法审了。定义放在**策略**这一侧
 * 而不是共享那一侧：这是一条规定（挂哪儿、什么权限），不是实现细节。
 */
export const SHARED_CELL_ROOT = '/shared'

/**
 * 凭据文件名规则：挂载源**命中即拒绝**，不看它在哪个目录下。
 *
 * 为什么需要这一条，而不是靠上面的前缀名单：**凭据文件就躺在配置文件的隔壁**。
 *
 *   ~/.claude/settings.json          配置
 *   ~/.claude/.credentials.json      ⚠️ 账户 OAuth 凭据
 *
 * 前缀名单拦的是「整个目录」，而这里要拦的是「目录里的那一个文件」——
 * `.credentials.json` 与 `settings.json` 共享同一个前缀，前缀规则区分不了它们。
 *
 * 所以这一条必须比前缀规则**先**判、而且报错要说清是「凭据」：
 * 只说「禁止路径」的话，用户看到的是一句他没法照做的提示（那个路径看上去人畜无害），
 * 然后大概率会去别的地方找一个更宽的挂载方式。
 *
 * 匹配只看文件名（basename），大小写不敏感：macOS 的默认文件系统大小写不敏感，
 * `.Credentials.json` 与 `.credentials.json` 在那里是同一个文件。
 * `*` 只支持「开头」或「结尾」两种，够用即可——这不是通用 glob。
 */
export const FORBIDDEN_CREDENTIAL_FILE_PATTERNS: readonly string[] = [
  '.credentials.json',
  'auth.json',
  '*.env',
  '*.pem',
  'id_rsa*',
]

/** 这个挂载源命中哪条凭据规则；没命中就是 `null`。 */
export function matchCredentialFileRule(source: string): string | null {
  const name = path.basename(source).toLowerCase()
  return FORBIDDEN_CREDENTIAL_FILE_PATTERNS.find((rule) => matchesCredentialRule(name, rule)) ?? null
}

function matchesCredentialRule(name: string, rule: string): boolean {
  const pattern = rule.toLowerCase()
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1))
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

/**
 * 主目录里这几处**子目录**不许当实例根。
 *
 * 为什么单列一条：实例根本来就落在主目录下（默认 `~/.abx/instances`），所以前缀
 * 名单里的 `/home` 那一条在这里必须让开——而让开之后 `~/.ssh/instances` 就没人拦了。
 * 这个名单补的就是这个口子。里面的东西有一个共同点：**读得到就等于拿到了身份**
 * （私钥、云凭据、kubeconfig、docker 凭据），而实例状态目录是可写挂载源，
 * 挂进去的哪怕只是它下面的一层，也足够把整个目录挖出来。
 */
export const FORBIDDEN_INSTANCE_ROOT_SUBDIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.kube',
  '.docker',
  '.claude',
  '.codex',
  '.dsh',
]

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

/** 唯一允许可写的两类挂载。别的组合都要在起容器前被拒。 */
export type WritableMountClass = 'taskDir' | 'instanceState'

export interface MountPolicy {
  readonly summary: string
  readonly rules: readonly MountPolicyRule[]
  readonly forbiddenMountPrefixes: readonly string[]
  readonly forbiddenInstanceRootSubdirs: readonly string[]
  readonly dangerousTaskDirs: readonly string[]
  /** 可写的两类。读代码的人问「舱内能改什么」，答案就是这一行。 */
  readonly writableClasses: readonly WritableMountClass[]
  /** 任务目录是不是可写。 */
  readonly taskDirMode: 'rw'
  /**
   * 实例状态目录是不是可写。
   *
   * 必须是 `rw`：历史要写得进去，这正是持久化的实现方式。只读的话目录挂上了、
   * 历史一行都落不下来，而命令行里看不出任何异常。
   */
  readonly stateDirMode: 'rw'
  /**
   * 共享条目挂进舱时是什么权限。
   *
   * 只有 `ro`。共享的是**宿主上用户自己已有的东西**（项目目录、资料、数据），
   * 舱内 agent 需要读它，不需要改它；可写共享是另一件要单独论证的事
   * （改了回不去、而且舱内一写就把共享变成了双向往来的通道）。
   */
  readonly sharedMountMode: 'ro'
  /**
   * 宿主主目录里的**现成内容**一个都不进舱。
   *
   * 从主目录下进去的只有两类，都是 abx 自己在 `~/.abx/` 里造出来的：
   *   - 生成的配置文件：只读、逐个文件、内容是 abx 现写的；
   *   - 实例状态目录 `~/.abx/instances/<instanceId>/<agentId>`：可写，但**初始为空**，
   *     之后装的全是舱内 agent 自己写下的东西。
   *
   * 「现成的」是这句话的关键：`.ssh`、`.aws`、浏览器数据这些**宿主已有的**内容
   * 一个字节都不进舱。
   */
  readonly mountsHostHome: false
  buildMounts(taskDir: string, workdir: string, agentConfigFiles?: readonly SandboxConfigFile[], stateDirs?: readonly SandboxStateDir[], sharedMounts?: readonly SandboxMount[]): readonly SandboxMount[]
}

export const MOUNT_POLICY: MountPolicy = {
  summary:
    '任务目录与实例状态目录以可写方式挂进舱内；abx 生成的那几个 agent 配置文件逐个只读挂进去；' +
    '用户显式共享的条目只读挂在 /shared 下；宿主上的其他一切都不挂。',
  writableClasses: ['taskDir', 'instanceState'],
  taskDirMode: 'rw',
  stateDirMode: 'rw',
  sharedMountMode: 'ro',
  mountsHostHome: false,
  forbiddenMountPrefixes: FORBIDDEN_MOUNT_PREFIXES,
  forbiddenInstanceRootSubdirs: FORBIDDEN_INSTANCE_ROOT_SUBDIRS,
  dangerousTaskDirs: DANGEROUS_TASK_DIRS,
  rules: [
    {
      requirement: '任务目录以 rw 挂载',
      rationale: 'agent 要在里面干活；这是用户自己指的那一个目录。',
    },
    {
      requirement: '实例状态目录以 rw 挂载，且必须在实例根（默认 ~/.abx/instances）之下',
      rationale:
        '会话历史要跨会话活下来，所以它必须是可写的；而它默认落在主目录下面，' +
        '可写 + 主目录是这套东西里最危险的组合，所以来源被收在 abx 自己造的实例根里。',
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
      requirement: '除任务目录与实例状态目录外不接受任何宿主路径',
      rationale: '需要读别的东西时，正确做法是复制进任务目录，而不是再开一个挂载点。',
    },
    {
      requirement: '凭据文件名一律不挂（.credentials.json / auth.json / *.env / *.pem / id_rsa*）',
      rationale:
        '这些文件与配置文件是同目录邻居：挂 ~/.claude/settings.json 时顺手把 ~/.claude 整个挂上，' +
        '等于把账户 OAuth 凭据送进舱。舱内 agent 只需要 abx 生成的那份配置。',
    },
    {
      requirement: 'agent 配置只从 abx 生成的那一个文件挂，且只读、逐个文件',
      rationale:
        '宿主那份 settings.json 里可能写着别家的 key、别的端点和别的模型，挂真的等于把它带进舱；' +
        '而目录形态会连隔壁的凭据一起带进去。只读是因为它每次起舱都会被重写——舱内改了也不会留下，' +
        '留着可写只会让人以为改得动。',
    },
    {
      requirement: '生成的配置挂回实例状态目录内部，那一格仍然只读',
      rationale:
        '配置文件就长在实例状态目录里，所以它在可写挂载**内部**再套一层只读挂载：' +
        '目录整体可写（历史要落盘），而配置那一格改不动。',
    },
    {
      requirement: '共享条目一律只读，且只挂在 /shared/<名字> 下',
      rationale:
        '共享的是宿主上用户自己已有的东西，舱内读得到就够了；改坏了是回不来的。' +
        '挂载点由 resolveSharedMounts() 算而不是调用方给，是因为这是唯一一类「可以多出来几个」' +
        '的挂载——位置再随便给，就没有一句话能说清舱内到底多了什么。',
    },
  ],
  buildMounts(taskDir: string, workdir: string, agentConfigFiles: readonly SandboxConfigFile[] = [], stateDirs: readonly SandboxStateDir[] = [], sharedMounts: readonly SandboxMount[] = []) {
    return [
      { source: path.resolve(taskDir), target: workdir, mode: 'rw' as const },
      // 实例状态目录：rw，目录形态（这里恰恰**要**目录，见 instance.ts 的解释）。
      ...stateDirs.map((dir) => ({ source: path.resolve(dir.hostPath), target: dir.cellPath, mode: 'rw' as const })),
      // 生成的文件逐个挂、只读。这一行是「单文件形态」唯一可能出现的地方，
      // 而它只认文件：每一项的来源是 `stageAgentConfig()` 写出来的那一个路径。
      ...agentConfigFiles.map((file) => ({ source: file.hostPath, target: file.cellPath, mode: 'ro' as const })),
      // 共享条目：形态已经由 `resolveSharedMounts()` 定死（ro + /shared/<名字>），
      // 这里原样带上，下面那道闸会再核一遍「确实是只读、确实挂在共享区里」。
      ...sharedMounts,
    ]
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
  if (matchCredentialFileRule(source) !== null) return true
  if (source === DOCKER_SOCKET_PATH) return true
  return FORBIDDEN_MOUNT_PREFIXES.some(
    (prefix) => source === prefix || source.startsWith(`${prefix}${path.sep}`),
  )
}

export interface AssertMountPolicyInput {
  readonly mounts: readonly SandboxMount[]
  readonly taskDir: string
  readonly workdir: string
  /**
   * abx 这次会话自己生成、允许只读进舱的 agent 配置文件。
   *
   * 这是**收紧**用的名单，不是放宽：列进来的每一项还要再满足「只读 + 挂回它原本的位置 +
   * 文件名在注册表里」。凭据文件即使被列进来也照样拒绝——那条判断更靠前。
   */
  readonly agentConfigFiles?: readonly SandboxConfigFile[]
  /**
   * 这次会话允许以 rw 挂进舱的实例状态目录。
   *
   * 和配置文件名单一样是**收紧**用的：列进来只是取得「可以过闸」的资格，
   * 每一项还要自己过 `assertStateDirPolicy` 那几道闸。
   */
  readonly stateDirs?: readonly SandboxStateDir[]
  /**
   * 这次会话允许挂进舱的共享条目，由 `resolveSharedMounts()` 算出来。
   *
   * 同样是**收紧**用的名单，而且这里没有第二层闸：共享源是用户自己选的宿主路径，
   * 「哪些路径不能共享」那套判定已经在 `resolveSharedMounts()` 里跑过一遍
   * （那道判定要读文件系统，放不进这个纯字符串的闸门里）。这里只核形态：
   * 只读、挂在 `/shared` 下、挂载点互不重复。
   */
  readonly sharedMounts?: readonly SandboxMount[]
  /** 实例根。缺省取 `ABX_INSTANCES_ROOT` / `~/.abx/instances`。 */
  readonly instancesRoot?: string
  /** 舱内 home。给了就顺带核一下状态目录挂在了舱内 home 底下。 */
  readonly cellHome?: string
  /** 宿主 home。缺省 `os.homedir()`；测试里覆盖它，免得跟着跑测试的人的主目录走。 */
  readonly homeDir?: string
}

export interface AssertStateDirPolicyInput {
  readonly stateDirs: readonly SandboxStateDir[]
  readonly instancesRoot?: string
  readonly cellHome?: string
  readonly homeDir?: string
}

/**
 * 实例状态目录那几道闸，**单独可以调**。
 *
 * 单独暴露出来是因为它必须在「往状态目录里写任何东西」之前跑：生成的配置就写在
 * 状态目录里面，等 `assertMountPolicy`（起容器前那一步）才发现路径不对时，
 * 文件已经顺着软链写到别处去了。所以调用顺序是**建目录 → 过这几道闸 → 再写**，
 * 见 `commands/open.ts`。
 *
 * 返回解析软链之后的实例根，调用方拿它做日志或者继续往下传。
 */
export function assertStateDirPolicy(input: AssertStateDirPolicyInput): string {
  const homeDir = realpathOrResolve(input.homeDir ?? homedir())
  const instancesRoot = assertInstancesRoot(input.instancesRoot ?? defaultInstancesRoot(), homeDir)

  for (const dir of input.stateDirs) {
    assertOneStateDir(dir, instancesRoot, homeDir, input.cellHome ?? null)
  }

  return instancesRoot
}

/**
 * 实例根自己也要过闸。
 *
 * 它平时是 `~/.abx/instances`（abx 自己造的），但这道闸不能省：它是从环境变量
 * 来的，而「把 `ABX_INSTANCES_ROOT` 配成 `/home`」这种写法，后果是**整个主目录**
 * 变成可写挂载源。这类事只要可能发生一次，就该在起容器之前被拒。
 */
export function assertInstancesRoot(instancesRoot: string, homeDir: string = realpathOrResolve(homedir())): string {
  if (!path.isAbsolute(instancesRoot)) {
    throw new MountPolicyViolation(`实例根必须是绝对路径：${instancesRoot}`)
  }
  if (instancesRoot.split(path.sep).includes('..')) {
    throw new MountPolicyViolation(`实例根里不允许出现 ..：${instancesRoot}`)
  }

  const root = realpathOrResolve(instancesRoot)

  if (root === path.parse(root).root) {
    throw new MountPolicyViolation(`拒绝把 ${root} 当实例根：它是文件系统的根。`)
  }

  // 主目录本身，或者主目录的上级。后者更隐蔽：`/home` 看上去只是「主目录的爸爸」，
  // 但把可写挂载源指到那儿，等于把这一台机器上所有用户的主目录一起交出去。
  if (root === homeDir || isAncestor(root, homeDir)) {
    throw new MountPolicyViolation(
      `拒绝把 ${root} 当实例根：它是宿主 home（${homeDir}）本身，或者是它的上级。` +
        `实例状态目录是可写挂载源，指到这里等于把整个主目录交出去。默认值是 ~/.abx/instances。`,
    )
  }

  if (DANGEROUS_TASK_DIRS.includes(root)) {
    throw new MountPolicyViolation(`拒绝把 ${root} 当实例根：它本身就是一个敏感位置。`)
  }

  // 禁挂前缀里，home 那一条要**让开**——默认实例根就在 home 下面。
  // 让开之后剩下的（/etc、/var/run、/proc、/root……）一条都不放。
  const prefix = FORBIDDEN_MOUNT_PREFIXES.find(
    (candidate) => candidate !== homeDir && !isAncestor(candidate, homeDir) && isUnder(root, candidate),
  )
  if (prefix !== undefined) {
    throw new MountPolicyViolation(`拒绝把 ${root} 当实例根：它落在禁挂前缀 ${prefix} 里。`)
  }

  // 主目录下面让开了前缀规则，但主目录里的那几处敏感子目录要单独拦
  // （否则 `~/.ssh/instances` 这种写法是能过的）。
  const sensitive = FORBIDDEN_INSTANCE_ROOT_SUBDIRS.find((name) => isUnder(root, path.join(homeDir, name)))
  if (sensitive !== undefined) {
    throw new MountPolicyViolation(
      `拒绝把 ${root} 当实例根：它在主目录的 ${sensitive}/ 下面。` +
        `那里的内容读得到就等于拿到了身份，不能作为可写挂载源。`,
    )
  }

  const rule = matchCredentialFileRule(root)
  if (rule !== null) {
    throw new MountPolicyViolation(`拒绝把 ${root} 当实例根：它命中凭据文件名规则 ${rule}。`)
  }

  return root
}

/**
 * 一个状态目录的四道闸。顺序是**便宜的先判、结论最具体的先说**。
 *
 *   1. 字面路径必须在实例根**之下** —— 挡住「直接拿宿主的 `~/.claude` 当状态目录」；
 *   2. `realpath` 之后仍必须在实例根之下 —— 挡住软链逃逸（`instances/x/claude`
 *      指向 `~/.claude` 时，字面路径完全正常，只有解开链接才看得见）；
 *   3. 不得是宿主 home 本身，也不得是它的祖先 —— 挡住「把整个主目录当状态目录」；
 *   4. 不得命中凭据文件名黑名单 —— 挡住名字正好叫 `.credentials.json` / `auth.json` /
 *      `*.env` / `*.pem` / `id_rsa*` 的目录。
 *
 * 第 2 道是**失败关闭**的：路径解析不出来（不存在、权限不够）就拒。这一刻目录已经
 * 由 `ensureInstanceStateDir` 建出来了，「解析不了」本身就说明哪里不对。
 *
 * 最后还有一条形状检查：状态目录必须是**实例目录的直接子目录**，且名字等于 agentId。
 * 它挡的是「把整个实例目录挂进去」——那样连 `sessions.jsonl` 一起进舱，
 * 而那个文件正是 abx 自己的记账。
 */
function assertOneStateDir(dir: SandboxStateDir, instancesRoot: string, homeDir: string, cellHome: string | null): void {
  if (!path.isAbsolute(dir.hostPath) || !path.isAbsolute(dir.cellPath)) {
    throw new MountPolicyViolation(`实例状态目录必须用绝对路径：${dir.hostPath} → ${dir.cellPath}`)
  }
  if (dir.hostPath.split(path.sep).includes('..')) {
    throw new MountPolicyViolation(`实例状态目录里不允许出现 ..：${dir.hostPath}`)
  }

  assertNotCredentialFile(dir.hostPath)

  const literal = path.resolve(dir.hostPath)
  // 闸 1：字面路径。
  if (!isUnder(literal, instancesRoot)) {
    throw new MountPolicyViolation(
      `拒绝把 ${dir.hostPath} 当实例状态目录：它不在实例根 ${instancesRoot} 之下。` +
        `宿主上现成的目录（例如 ~/.claude）不能直接挂进去，那会把宿主那台机器上的历史与凭据一起带进舱。` +
        `abx 只挂自己在实例根里造出来的目录。`,
    )
  }

  // 闸 2：realpath。软链是这里唯一能骗过闸 1 的东西。
  const resolved = realpathOrNull(literal)
  if (resolved === null) {
    throw new MountPolicyViolation(
      `实例状态目录 ${dir.hostPath} 解析不了（不存在？权限不够？）：解析不了就没法确认它没有顺着软链跑出实例根，所以拒绝。`,
    )
  }
  if (!isUnder(resolved, instancesRoot)) {
    throw new MountPolicyViolation(
      `拒绝把 ${dir.hostPath} 当实例状态目录：解析软链之后它是 ${resolved}，跑出实例根 ${instancesRoot} 了。`,
    )
  }

  // 闸 3：主目录本身/它的上级。
  if (resolved === homeDir || isAncestor(resolved, homeDir)) {
    throw new MountPolicyViolation(
      `拒绝把 ${dir.hostPath} 当实例状态目录：它是宿主 home（${homeDir}）本身或者是它的上级。`,
    )
  }

  // 形状：必须是 `<instancesRoot>/<instanceId>/<agentId>` 那一格。
  if (path.dirname(path.dirname(resolved)) !== instancesRoot || path.basename(resolved) !== dir.agentId) {
    throw new MountPolicyViolation(
      `拒绝把 ${dir.hostPath} 当实例状态目录：它必须是 <实例根>/<实例 id>/${dir.agentId} 那一格，` +
        `不能是实例目录本身（那里有 abx 自己的记账文件）也不能是别的深度。`,
    )
  }

  if (cellHome !== null && !isUnder(dir.cellPath, cellHome)) {
    throw new MountPolicyViolation(
      `实例状态目录的舱内挂载点 ${dir.cellPath} 不在舱内 home（${cellHome}）之下：` +
        `agent 只会往自己的 home 里写历史，挂到别处等于没挂。`,
    )
  }
}

/**
 * 起容器之前把挂载清单过一遍。违反任何一条就抛。
 *
 * 会在这里抛而不是打个警告，是因为这些组合没有一种是「配置写错了但还是能跑」——
 * 它们全都是「跑起来了，但隔离没了」。
 *
 * 检查顺序是**凭据 → 禁挂路径 → 结构**。理由很实际：一个同时犯了两个错的配置，
 * 用户最需要看到的是「这是凭据文件」或者「你挂到 /home 去了」，
 * 而不是「挂载点数量不对」——后两句话他没法照着改。
 */
export function assertMountPolicy(input: AssertMountPolicyInput): void {
  const taskDir = path.resolve(input.taskDir)
  const { mounts, workdir } = input

  const configFiles = input.agentConfigFiles ?? []
  assertConfigFileAllowList(configFiles)
  const allowedConfigSources = new Map(configFiles.map((file) => [file.hostPath, file]))

  const stateDirs = input.stateDirs ?? []
  // 状态目录那组闸先跑：它们判的是「来源本身能不能信」，比逐条挂载的检查更根本。
  // 没有状态目录时**不跑**：实例根的默认值跟着跑命令的人的主目录走，在没有状态
  // 目录的场合拿它去判，只会凭空多出一种跟环境相关的失败。
  if (stateDirs.length > 0) {
    assertStateDirPolicy({
      stateDirs,
      homeDir: input.homeDir,
      cellHome: input.cellHome,
      instancesRoot: input.instancesRoot,
    })
  }
  const allowedStateDirs = new Map(stateDirs.map((dir) => [path.resolve(dir.hostPath), dir]))

  // 共享挂载按**挂载点**索引，不按来源：同一个目录共享两次时来源相同、挂载点不同
  // （`/shared/notes` 与 `/shared/notes-2`），按来源索引会把前一个悄悄弄丢。
  const sharedMounts = input.sharedMounts ?? []
  assertSharedMountTargetsUnique(sharedMounts)
  const allowedSharedMounts = new Map(sharedMounts.map((mount) => [mount.target, mount]))
  // 兜底索引：挂载点对不上时按来源再找一次，这样「来源对、挂到别处去了」得到的是
  // 一句说挂载点的话，而不是一句「这个来源不许挂」——后者会让用户去改来源，而错在挂载点。
  const sharedBySource = new Map(sharedMounts.map((mount) => [mount.source, mount]))

  for (const mount of mounts) {
    if (!path.isAbsolute(mount.source) || !path.isAbsolute(mount.target)) {
      throw new MountPolicyViolation(`挂载必须用绝对路径：${mount.source} → ${mount.target}`)
    }

    // `..` 能把一个看起来人畜无害的路径变成 `/home`。
    if (mount.source.split(path.sep).includes('..')) {
      throw new MountPolicyViolation(`挂载路径里不允许出现 ..：${mount.source}`)
    }

    // 凭据文件排在最前面判，而且**不分场合**：前缀规则区分不了
    // `~/.claude/settings.json` 与它隔壁的 `~/.claude/.credentials.json`，
    // 而这条规则可以。任务目录是唯一豁免——它是用户自己选的**目录**
    // （CLI 起容器前已经确认过是个目录），文件名的黑名单管不到目录上去。
    if (mount.source !== taskDir) assertNotCredentialFile(mount.source)

    const allowedConfig = allowedConfigSources.get(mount.source)
    if (allowedConfig !== undefined) {
      assertConfigMount(mount, allowedConfig)
      continue
    }

    const allowedStateDir = allowedStateDirs.get(path.resolve(mount.source))
    if (allowedStateDir !== undefined) {
      assertStateDirMount(mount, allowedStateDir)
      continue
    }

    // 共享挂载排在禁挂前缀检查**前面**，而且必须排前面：共享源本来就住在主目录下面，
    // 而 `/home` 正是禁挂前缀里的一条。名单放行只是给了它一张准考证，
    // 形态（只读 + 挂在共享区里）在下面那几行里逐条核。
    const allowedShared = allowedSharedMounts.get(mount.target) ?? sharedBySource.get(mount.source)
    if (allowedShared !== undefined) {
      assertSharedMount(mount, allowedShared)
      continue
    }

    // 任务目录由用户显式指定，豁免前缀规则；其余的挂载源一个都不放过。
    if (mount.source === taskDir) continue

    // 「把配置目录挂进去」是这件事最容易走错的一步，而且错得悄无声息
    // （目录里就有凭据文件）。所以挂到那份配置的父目录时单独给一句话，
    // 说清要的是里面的哪个文件。
    const directoryOwner = configFiles.find((file) => isAncestor(mount.source, file.hostPath))
    if (directoryOwner !== undefined) {
      throw new MountPolicyViolation(
        `拒绝挂载 ${mount.source}：这是个目录，而里面既有配置也有凭据。` +
          `要挂的是那一个生成出来的文件：${directoryOwner.hostPath}（只读）。`,
      )
    }

    if (isForbiddenMountSource(mount.source)) {
      // docker socket 单独给一句话：它是最容易被顺手挂进去、后果也最严重的一个
      // （挂进去等于把宿主 root 交出去），值得在报错里被点名。
      if (mount.source === DOCKER_SOCKET_PATH) {
        throw new MountPolicyViolation(
          `拒绝挂载 docker socket（${DOCKER_SOCKET_PATH}）：舱内能指挥宿主 docker 就等于没有隔离。` +
            `需要构建镜像时，请在宿主机上手动构建。`,
        )
      }
      throw new MountPolicyViolation(
        `拒绝挂载 ${mount.source}：除任务目录、实例状态目录、abx 生成的那几个配置文件` +
          `与用户显式共享的条目外，宿主路径一律不进舱内。` +
          `需要里面的文件时，要么把它拖进面板共享，要么复制到任务目录，而不是开一个挂载点。`,
      )
    }
  }

  // 可写的上限：任务目录一个 + 每个实例状态目录一个。两类之外的任何可写挂载，
  // 到下面那个结构检查里还会再被拒一次——这里先给一句更直白的。
  const writable = mounts.filter((mount) => mount.mode === 'rw')
  const writableLimit = 1 + stateDirs.length
  if (writable.length > writableLimit) {
    throw new MountPolicyViolation(
      `可写挂载最多 ${writableLimit} 个（任务目录 1 个 + 实例状态目录 ${stateDirs.length} 个），` +
        `实际有 ${writable.length} 个：${writable.map((mount) => mount.source).join(', ')}`,
    )
  }

  if (DANGEROUS_TASK_DIRS.includes(taskDir)) {
    throw new MountPolicyViolation(
      `拒绝把 ${taskDir} 作为任务目录：它本身就是一个敏感位置。请指向具体项目目录。`,
    )
  }

  for (const mount of mounts) {
    const isTaskDir = mount.source === taskDir
    const isConfigFile = allowedConfigSources.has(mount.source)
    const isStateDir = allowedStateDirs.has(path.resolve(mount.source))
    const isShared = allowedSharedMounts.has(mount.target)
    if (!isTaskDir && !isConfigFile && !isStateDir && !isShared) {
      throw new MountPolicyViolation(
        `除任务目录 ${taskDir}、实例状态目录、abx 生成的配置文件与用户显式共享的条目外不允许有别的挂载源，实际是 ${mount.source}`,
      )
    }
    if (isTaskDir && mount.target !== workdir) {
      throw new MountPolicyViolation(`除工作目录 ${workdir} 外不允许有别的挂载点，实际是 ${mount.target}`)
    }
  }
}

/**
 * 状态目录挂载的形状：rw、挂回它自己的位置。
 *
 * 与配置文件那条刚好相反——那边只读、这边必须可写。理由都写在各自的消息里，
 * 因为「为什么这块能写那块不能写」是最容易被后来的人改错的一处。
 */
function assertStateDirMount(mount: SandboxMount, dir: SandboxStateDir): void {
  if (mount.mode !== 'rw') {
    throw new MountPolicyViolation(
      `实例状态目录必须以 rw 挂载，${mount.source} 被要求以 ${mount.mode} 挂进去：` +
        `只读的话舱内的历史一行都写不下来，而界面上看不出任何异常。`,
    )
  }
  if (mount.target !== dir.cellPath) {
    throw new MountPolicyViolation(
      `实例状态目录必须挂回它自己的位置：${mount.source} 应挂到 ${dir.cellPath}，实际是 ${mount.target}。` +
        `挂到别处等于没挂——agent 只往自己的 home 里写历史。`,
    )
  }
}

/**
 * 共享挂载的形状：只读、挂在 `<共享区根>/<名字>` 那一层、来源就是名单里那一个。
 *
 * 与状态目录那条刚好相反（那边必须可写），理由都写在消息里：可写共享意味着舱内能改
 * 宿主上用户自己的文件，而改坏了回不去——这不是「顺手放宽一格」的事。
 *
 * 来源也要核一遍：挂载点对得上、来源却被换成一个敏感目录，是这份名单唯一防不住的
 * 走法（挂载点由 `resolveSharedMounts()` 算，改来源比改挂载点容易）。
 */
function assertSharedMount(mount: SandboxMount, expected: SandboxMount): void {
  if (mount.source !== expected.source) {
    throw new MountPolicyViolation(
      `共享挂载 ${mount.target} 的来源是 ${mount.source}，而这次会话批准的来源是 ${expected.source}：` +
        `挂载点对得上不代表来源对得上，两者必须一起对。`,
    )
  }
  if (mount.mode !== 'ro') {
    throw new MountPolicyViolation(
      `共享条目只能只读挂载，${mount.source} 被要求以 ${mount.mode} 挂进去：` +
        `共享的是宿主上用户自己的文件，舱内改坏了是回不来的。需要舱内能写的东西请放进任务目录。`,
    )
  }
  // 形状：正好一层，不许嵌套，也不许就是共享区根本身。
  if (path.dirname(mount.target) !== SHARED_CELL_ROOT) {
    throw new MountPolicyViolation(
      `共享条目必须挂在 ${SHARED_CELL_ROOT}/<名字> 那一层，实际是 ${mount.target}：` +
        `挂载点由 resolveSharedMounts() 算，调用方给不了——换了位置，舱内就多出一个没人说得清来历的目录。`,
    )
  }
}

/**
 * 两个共享条目的挂载点不能是同一个。
 *
 * 挂载点撞车意味着后一个把前一个盖掉，而两个都在列表里、界面上都显示「已共享」。
 * 这类事在命令行里看不出来，只在「我明明共享了 a/notes，舱内打开却是 b/notes」时
 * 才被发现——所以宁可在起容器之前就拒。
 */
function assertSharedMountTargetsUnique(sharedMounts: readonly SandboxMount[]): void {
  const seen = new Set<string>()
  for (const mount of sharedMounts) {
    if (seen.has(mount.target)) {
      throw new MountPolicyViolation(`两个共享条目挂在同一个位置 ${mount.target}：后一个会把前一个盖掉，只剩一个。`)
    }
    seen.add(mount.target)
  }
}

/**
 * 凭据文件在任何情况下都不进舱——包括「abx 自己生成的文件」这份名单。
 *
 * 单独一个函数是因为它有两个调用点（挂载清单、允许清单），而两处必须给出**同一句话**：
 * 报错说的是「这是凭据文件」，不是「路径不合法」。用户看到前者才知道该换个做法，
 * 看到后者只会去找一个更宽的挂载方式。
 */
function assertNotCredentialFile(source: string): void {
  const rule = matchCredentialFileRule(source)
  if (rule === null) return
  throw new MountPolicyViolation(
    `拒绝挂载 ${source}：这是凭据文件（命中规则 ${rule}），不能挂进舱。` +
      `挂配置文件时请只挂 abx 生成的那一个文件，不要挂它所在的目录；` +
      `真凭据由气闸在宿主这一侧注入，舱内永远拿不到。`,
  )
}

/** 允许清单本身也要过一遍：它决定谁可以豁免「除任务目录外一律不许挂」。 */
function assertConfigFileAllowList(files: readonly SandboxConfigFile[]): void {
  const known = agentConfigFileNames()
  for (const file of files) {
    if (!path.isAbsolute(file.hostPath) || !path.isAbsolute(file.cellPath)) {
      throw new MountPolicyViolation(`生成的配置只能用绝对路径：${file.hostPath} → ${file.cellPath}`)
    }
    // 凭据先判：名单里混进一个 `auth.json` 时，要说的是「这是凭据」，
    // 而不是「这个名字不在配置文件名名单里」。
    assertNotCredentialFile(file.hostPath)
    // 名字对不上注册表就不放行。这一条挡的是「把生成目录整个挂进去」——
    // 那种形态在调用方看起来只是「路径少写了一段」，后果却是凭据一起进舱。
    if (!known.includes(path.basename(file.hostPath))) {
      throw new MountPolicyViolation(
        `拒绝把 ${file.hostPath} 当 agent 配置挂进舱：能挂的只有生成出来的那一个文件（${known.join(' / ')}），不是它所在的目录。`,
      )
    }
  }
}

function assertConfigMount(mount: SandboxMount, file: SandboxConfigFile): void {
  if (mount.mode !== 'ro') {
    throw new MountPolicyViolation(
      `abx 生成的配置只能只读挂载，${mount.source} 被要求以 ${mount.mode} 挂进去：` +
        `它每次起舱都会被重写，可写只会让舱内以为改得动。`,
    )
  }
  if (mount.target !== file.cellPath) {
    throw new MountPolicyViolation(
      `生成的配置必须挂回它原本的位置：${mount.source} 应挂到 ${file.cellPath}，实际是 ${mount.target}。` +
        `路径不一致等于没配——agent 只去那个固定的地方找配置。`,
    )
  }
}

/**
 * 这两个是整套闸门的基本词：`isAncestor(a, b)` 是「a 是 b 的上级」，
 * `isUnder(c, p)` 是「c 就在 p 里面（或就是 p）」。
 *
 * 导出给 `shared.ts` 用。理由不是省两行，是**两边必须逐字一致**：
 * 前缀判定差一个字符（`/homely` 算不算 `/home` 下面）就是一道闸门的开与关。
 */
export function isAncestor(candidate: string, filePath: string): boolean {
  return filePath.startsWith(`${candidate}${path.sep}`)
}

/** `child` 是 `parent` 本身或者它下面的一层。`/homely` 不算 `/home` 下面。 */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || isAncestor(parent, child)
}

/**
 * 解析软链。路径不存在时退回 `path.resolve`。
 *
 * 只用在**实例根**上：它可能还没被建出来（比如这次会话用的是 local 后端，压根
 * 不碰实例目录），而此时「按字面路径判」仍然是有意义的——闸门要挡的是
 * 「指到主目录去了」这种明摆着的错。
 */
function realpathOrResolve(target: string): string {
  return realpathOrNull(target) ?? path.resolve(target)
}

/**
 * 解析软链；解析不了就是 `null`。
 *
 * 状态目录那一道闸用它，而且是**失败关闭**的：那一刻目录刚由
 * `ensureInstanceStateDir()` 建出来，解析不了说明有别的事，宁可拒掉。
 */
function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target)
  } catch {
    return null
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
