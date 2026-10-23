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
  AGENT_DEFINITIONS,
  ABX_BROKER_ORIGIN_ENV,
  ABX_CELL_ID_ENV,
  ABX_CELL_TOKEN_ENV,
  ABX_UPSTREAM_ID_ENV,
  agentIds,
  findAgent,
} from './agents'
/** 产品名。提示语、默认路径、测试都从这里取，不许各处硬编码。 */
export const productName = 'abx'

export type { AgentDefinition } from './agents'

export { expandEnvRefs, expandEnvTree } from './expand-env'
export type { ExpandResult } from './expand-env'

export { findInlineSecrets } from './inline-secret-guard'
export type { InlineSecretFinding, InlineSecretReason } from './inline-secret-guard'

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
