/**
 * `@abx/session` 的公开面。
 */

export { assertNoForbiddenEnv } from './backend'
export type {
  SandboxBackend,
  SandboxConfigFile,
  SandboxExit,
  SandboxHandle,
  SandboxIo,
  SandboxMount,
  SandboxRuntimeFile,
  SandboxSpec,
  SandboxStateDir,
} from './backend'

export { createDockerBackend, buildDockerArgs, containerName, isExecutableOnPath, probeDocker } from './docker-backend'
export type { DockerBackendOptions, DockerProbeResult } from './docker-backend'

export { LOCAL_BACKEND_WARNING, createLocalBackend, probeUserNamespaces } from './local-backend'
export type { LocalBackendOptions, UsernsProbeResult } from './local-backend'

export {
  DANGEROUS_HOST_ENV_NAMES,
  buildCellEnv,
  cellBaseUrlFor,
  generateCellId,
  scrubEnv,
} from './env'
export type { BuildCellEnvOptions, CellBaseUrlOptions, ScrubEnvResult } from './env'

export {
  AgentConfigError,
  agentHomePath,
  renderAgentConfig,
  stageAgentConfig,
  toSandboxConfigFiles,
} from './agent-config'
export type {
  RenderAgentConfigOptions,
  RenderedAgentConfig,
  RenderedAgentConfigFile,
  StageAgentConfigOptions,
  StagedAgentConfig,
  StagedAgentConfigFile,
} from './agent-config'

export {
  INSTANCES_ROOT_ENV,
  InstanceError,
  appendSessionRecord,
  defaultInstancesRoot,
  ensureInstanceStateDir,
  isValidInstanceId,
  planInstance,
} from './instance'
export type { InstancePlan, InstancePlanInput, InstanceSessionRecord } from './instance'

export {
  EXTRA_FORBIDDEN_SHARED_PREFIXES,
  MAX_REPORTED_CREDENTIAL_FILES,
  MAX_SHARED_SCAN_ENTRIES,
  SHARED_SCAN_SKIPPED_DIRS,
  inspectSharedEntry,
  resolveSharedMounts,
  sharedSourceViolationReason,
} from './shared'
export type { ResolveSharedMountsOptions, ResolveSharedMountsResult, SharedSourceContext } from './shared'

export {
  SHARED_LIST_FILE_NAME,
  addSharedEntries,
  defaultSharedListPath,
  markMissingEntries,
  readSharedEntries,
  writeSharedEntries,
} from './shared-store'

export {
  DANGEROUS_TASK_DIRS,
  DOCKER_SOCKET_PATH,
  FORBIDDEN_CREDENTIAL_FILE_PATTERNS,
  FORBIDDEN_INSTANCE_ROOT_SUBDIRS,
  FORBIDDEN_MOUNT_PREFIXES,
  MOUNT_POLICY,
  MountPolicyViolation,
  RUNTIME_FILE_SHAPES,
  SHARED_CELL_ROOT,
  assertInstancesRoot,
  assertMountPolicy,
  assertRuntimeRoot,
  assertStateDirPolicy,
  findRiskyFilesInTaskDir,
  isForbiddenMountSource,
  matchCredentialFileRule,
} from './mount-policy'
export type {
  AssertMountPolicyInput,
  AssertStateDirPolicyInput,
  MountPolicy,
  MountPolicyRule,
  WritableMountClass,
} from './mount-policy'

import { SANDBOX_BACKEND_IDS } from '@abx/contracts'
import type { SandboxBackendId } from '@abx/contracts'
import type { SandboxBackend } from './backend'
import { createDockerBackend } from './docker-backend'
import { createLocalBackend } from './local-backend'

/**
 * id → 造后端的工厂。**这张表就是「支持哪些后端」的答案。**
 *
 * 类型写成 `Record<SandboxBackendId, ...>` 而不是一个三元表达式，是要让一件事
 * 变成**编译错误**：往契约里加一个后端 id、却没有在这里给出实现。
 *
 * 之前这里是 `id === 'docker' ? createDockerBackend() : createLocalBackend()`——
 * 于**任何**不是 `docker` 的 id 都会静默拿到 local 后端：一个没有隔离、
 * `isRealSandbox: false` 的东西，长得却和 docker 一模一样（同一个 `SandboxBackend`
 * 接口）。为「保留以后加后端的口子」而扩展 enum 的人，只要忘记改那一行，得到的
 * 就是一个没有隔离的会话，而且从界面上看不出来。这种事不该靠「记得改这里」。
 */
const backendFactories: Record<SandboxBackendId, () => SandboxBackend> = {
  docker: createDockerBackend,
  local: createLocalBackend,
}

/**
 * 这个 id 有没有实现。
 *
 * 判据是工厂表自己的键，不是另抄一份名单：`backendFactories` 的类型已经钉住
 * 「键集恰好等于 `SandboxBackendId`」，所以 `hasOwn` 为真就等于它是受支持的 id。
 */
function isSupportedBackendId(value: string): value is SandboxBackendId {
  return Object.hasOwn(backendFactories, value)
}

/**
 * 按 id 造后端。CLI 只调这一个。
 *
 * 参数收 `string` 而不是 `SandboxBackendId`：这个值来自配置文件、命令行和 IPC，
 * 到这一层时已经穿过了一道校验边界，类型只是「应该是什么」，运行期还是得自己查。
 *
 * 查不到就**响亮失败**：报出这个 id 和支持的名单，然后什么后端都不造。
 * **绝不回退到任何一个「能跑」的后端**——尤其不许回退到 local：那会把一次拼错的
 * id 变成一次「看起来正常、实际上没有隔离」的会话，而两者在界面上长得一样。
 * 一个叫 `abx open --backend podman` 的人，宁可看到一句错，也不该拿到一个假沙箱。
 */
export function createBackend(id: string): SandboxBackend {
  if (!isSupportedBackendId(id)) {
    const supported = SANDBOX_BACKEND_IDS.map((name) => `"${name}"`).join(' 或 ')
    throw new Error(
      `不认识的后端 "${id}"：没有造出任何后端。支持的后端是 ${supported}。` +
        `这里不会退回 "local"——它不是沙箱。`,
    )
  }
  return backendFactories[id]()
}
