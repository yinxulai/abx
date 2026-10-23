/**
 * 测试用的配置构造器。
 *
 * 放在 contracts 而不是各自的测试目录里，是因为 broker / session / cli 的用例
 * 都要造同一份 `AbxConfig`。三份各写各的，迟早会出现「broker 的用例里
 * 上游带 secretFile，session 的用例里没有」这种漂移，而漂移出来的测试看起来
 * 还是绿的。
 *
 * 这里的值全是假的。任何真实凭据都不该出现在这个文件里——包括「看起来像真的」
 * 的示例值，因为示例值会被人复制。
 */

import type { AbxConfig, BrokerConfig, EgressRule, SessionConfig, Upstream } from './config'
import { DEFAULT_CONFIG } from './load-config'

export function makeUpstream(partial: Partial<Upstream> & Pick<Upstream, 'id' | 'baseUrl'>): Upstream {
  return {
    authHeader: 'authorization',
    authScheme: 'Bearer',
    secretEnv: 'ABX_TEST_SECRET',
    secretFile: null,
    ...partial,
  }
}

export function makeEgressRule(partial: Partial<EgressRule> & Pick<EgressRule, 'pattern'>): EgressRule {
  return { upstreamId: null, ...partial }
}

export interface MakeConfigOverrides {
  readonly broker?: Partial<BrokerConfig>
  readonly egress?: readonly EgressRule[]
  readonly upstreams?: readonly Upstream[]
  readonly session?: Partial<SessionConfig>
}

export function makeConfig(overrides: MakeConfigOverrides = {}): AbxConfig {
  return {
    broker: { ...DEFAULT_CONFIG.broker, ...overrides.broker },
    egress: overrides.egress ?? [],
    upstreams: overrides.upstreams ?? [],
    session: { ...DEFAULT_CONFIG.session, ...overrides.session },
  }
}
