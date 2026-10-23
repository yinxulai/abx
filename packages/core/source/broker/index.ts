/**
 * `@abx/broker` 的公开面。
 *
 * 用它的方式只有一种：`startBroker(...)` 拿到 handle，然后 `close()`。
 * 里面的路由、决策、转发都是可测的纯函数或近纯函数，单独导出是为了让测试
 * 能直接打到那一层，而不是每次都起一个真的 HTTP 服务。
 */

export {
  createFileAuditSink,
  createMemoryAuditSink,
  sanitizeField,
  toAuditLine,
} from './audit'
export type { AuditDecision, AuditRecord, AuditSink, BrokerFace, MemoryAuditSink } from './audit'

export {
  SecretValue,
  buildAuthHeaderValue,
  collectSecretEnvNames,
  resolveUpstreamSecret,
  safeEqual,
} from './credentials'
export type { SecretDependencies, SecretFailureReason, SecretResolution } from './credentials'

export { buildOutboundHeaders, forwardRequest, pickTransport, writeJson } from './forward'
export type { ForwardOptions, ForwardOutcome, OutboundAuth } from './forward'

export {
  CELL_ID_HEADER,
  CELL_PATH_PREFIX,
  CELL_TOKEN_HEADER,
  TARGET_HEADER,
  UPSTREAM_PATH_PREFIX,
  extractCellToken,
  resolveRoute,
} from './route'
export type { BrokerRoute, CellTokenExtraction, CellTokenSource as CellTokenOrigin, RouteInput } from './route'

export { concatUpstreamPath, resolveTarget, STRIPPED_AUTH_HEADERS } from './target'
export type { ResolvedFailure, ResolvedTarget, TargetResolution } from './target'

export {
  DEFAULT_ALLOWED_CELL_SUBNETS,
  LOOPBACK_SUBNET,
  classifyCellSource,
  findInvalidCellSubnets,
  isAllowedCellSource,
  isLoopbackAddress,
  normalizeRemoteAddress,
} from './cell-source'
export type { CellSourceCheck, CellSourceReason } from './cell-source'

export { DEFAULT_CELL_REGISTRY_LIMIT, CellRegistryError, CellTokenRegistry } from './registry'
export type { CellRegistryOptions } from './registry'

export { DEFAULT_CELL_ID, consoleLogger, formatHostForUrl, startBroker } from './server'
export type { BrokerHandle, BrokerLogger, BrokerOptions } from './server'

export { CELL_TOKEN_FILE_NAME, defaultCellTokenPath, generateCellToken, readCellTokenFile, writeCellTokenFile } from './token'
