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
  SHARED_CELL_ROOT,
  assertInstancesRoot,
  assertMountPolicy,
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

import type { SandboxBackendId } from '@abx/contracts'
import type { SandboxBackend } from './backend'
import { createDockerBackend } from './docker-backend'
import { createLocalBackend } from './local-backend'

/** 按 id 造后端。CLI 只调这一个。 */
export function createBackend(id: SandboxBackendId): SandboxBackend {
  return id === 'docker' ? createDockerBackend() : createLocalBackend()
}
