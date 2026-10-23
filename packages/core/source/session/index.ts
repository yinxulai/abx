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
  cellRootFor,
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
  DANGEROUS_TASK_DIRS,
  DOCKER_SOCKET_PATH,
  FORBIDDEN_CREDENTIAL_FILE_PATTERNS,
  FORBIDDEN_MOUNT_PREFIXES,
  MOUNT_POLICY,
  MountPolicyViolation,
  assertMountPolicy,
  findRiskyFilesInTaskDir,
  isForbiddenMountSource,
  matchCredentialFileRule,
} from './mount-policy'
export type { AssertMountPolicyInput, MountPolicy, MountPolicyRule } from './mount-policy'

import type { SandboxBackendId } from '@abx/contracts'
import type { SandboxBackend } from './backend'
import { createDockerBackend } from './docker-backend'
import { createLocalBackend } from './local-backend'

/** 按 id 造后端。CLI 只调这一个。 */
export function createBackend(id: SandboxBackendId): SandboxBackend {
  return id === 'docker' ? createDockerBackend() : createLocalBackend()
}
