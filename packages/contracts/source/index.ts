/**
 * `@abx/contracts` 的公开面。
 *
 * 这个包只放「形状」：配置长什么样、agent 注册表、域名语法、报错类型。
 * 它不转发任何请求、不起任何进程，也不读任何凭据——所以它可以被任何一层 import，
 * 包括最终会被塞进舱内的那些代码路径。
 */

export type {
  AbxConfig,
  BrokerConfig,
  EgressRule,
  ResourceLimits,
  SandboxBackendId,
  SessionConfig,
  Upstream,
  UpstreamIndex,
} from './config'

export {
  AGENT_CONFIG_TEMPLATE_VARIABLES,
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  ABX_BROKER_ORIGIN_ENV,
  ABX_CELL_ID_ENV,
  ABX_CELL_TOKEN_ENV,
  ABX_UPSTREAM_ID_ENV,
  AgentManifestError,
  agentConfigFileNames,
  agentHomeDirNames,
  agentIds,
  agentImageRef,
  agentManifestProblems,
  findAgent,
  generatedConfigFiles,
  renderAgentConfigTemplate,
  templateVariableNames,
} from './agents'
/** 产品名。提示语、默认路径、测试都从这里取，不许各处硬编码。 */
export const productName = 'abx'

/**
 * 舱内那个 home 的默认值（`session.cellHome`）。
 *
 * 它出现在两个地方：配置的默认值，以及「把注册表里的 `~/.claude/...` 展开成舱内
 * 路径」的那一步。两处必须同一个值，所以它是一个导出常量。
 */
export { DEFAULT_CELL_HOME, SANDBOX_BACKEND_IDS } from './schema'

export type {
  AgentConfigFile,
  AgentConfigFormat,
  AgentDefinition,
  AgentIcon,
  AgentImage,
  AgentStatePath,
} from './agents'

export { expandEnvRefs, expandEnvTree } from './expand-env'
export type { ExpandResult } from './expand-env'

export { findInlineSecrets } from './inline-secret-guard'
export type { InlineSecretFinding, InlineSecretReason } from './inline-secret-guard'

export {
  SHARED_ENTRY_KINDS,
  parseSharedEntry,
  sharedEntrySchema,
} from './shared-entry'
export type {
  ParseSharedEntryResult,
  SharedEntry,
  SharedEntryKind,
  SharedEntryRejection,
  SharedEntryState,
  SharedListSnapshot,
} from './shared-entry'

export {
  AUTO_OPEN_EXTENSIONS,
  INLINE_PREVIEW_EXTENSIONS,
  MAX_DELIVERABLE_BYTES,
  MCP_SHIM_CELL_PATH,
  MCP_SHIM_FILE_NAME,
  NEVER_AUTO_OPEN_EXTENSIONS,
  TRANSOM_ENDPOINT_PATH,
  TRANSOM_SERVER_NAME,
  TRANSOM_SERVER_VERSION,
  TRANSOM_TOOL_NAMES,
  classifyDeliverable,
  formatBytes,
} from './transom'
export type { DeliverableClassification, DeliverableDisposition } from './transom'

export { normalizeHost, isIpv4Literal, isValidHostname, isValidDomainPattern, parseDomainPattern } from './domain-pattern'
export type { DomainPattern, ParseDomainPatternResult } from './domain-pattern'

export { CONFIG_FILE_NAME, findConfigFile } from './config-path'
export type { FindConfigOptions, FindConfigResult } from './config-path'

export { ConfigError, IssueCollector, renderIssues } from './issues'
export type { ConfigIssue } from './issues'

export {
  DEFAULT_CONFIG,
  listWildcardPatterns,
  loadConfig,
  loadConfigOrThrow,
  parseConfig,
} from './load-config'
export type { LoadConfigOptions, LoadConfigResult, ParseConfigOptions } from './load-config'
