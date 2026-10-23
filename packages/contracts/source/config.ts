/**
 * 配置形状。
 *
 * 这里**只有类型**，而且是推导出来的：形状写在 `schema.ts` 的 zod schema 里，
 * 类型从它 `z.infer` 出来（见 `index.ts` 的公开面）。手写这份 interface 的日子
 * 已经过去了——那样等于把同一条规则写第二遍，漏改一处就是「类型允许但校验拒绝」。
 * 字段的含义、默认值、取值范围一并写在 schema 上，那才是唯一需要改的地方。
 *
 * 一条铁律贯穿全文件：**配置里不出现明文密钥**。上游凭据只以「引用」的形式存在，
 * 要么指向一个环境变量名（`secretEnv`），要么指向一个文件路径（`secretFile`）。
 * 真实值只在 broker 转发的那一刻从宿主的进程环境 / 文件系统里读出来，进不了仓库、
 * 进不了日志、也进不了舱内。
 *
 * 可选字段一律是 `| null` 而不是 `?`，让「没配」和「配了个空」在类型上就是两件事，
 * 读代码的人不需要去猜 `undefined` 和 `null` 的区别。这同时也是 schema 的形状：
 * 缺省值在解析时就已经填好，出来的一定是完整的一份配置。
 */

import type { z } from 'zod'
import {
  abxConfigSchema,
  brokerSchema,
  egressRuleSchema,
  resourceLimitsSchema,
  sandboxBackendSchema,
  sessionSchema,
  upstreamSchema,
} from './schema'

/**
 * 递归只读。
 *
 * schema 推出来的类型是可变的，而这份配置从加载那一刻起就不该再被谁改写：
 * 它是全进程共享的一份数据，谁都能改的话，「这个值什么时候变的」就查不清了。
 */
type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value

/** 上游：舱内请求的落点，以及转发时要注入的凭据从哪儿来。 */
export type Upstream = DeepReadonly<z.infer<typeof upstreamSchema>>

/**
 * 出口白名单的一条。
 *
 * `upstreamId` 为 `null` 时是「直通」：放行这个域名，但 broker 不知道该注入谁的凭据，
 * 于是只把舱内的占位符剥掉、原样转发（见 `@abx/broker` 的 route 注释）。
 */
export type EgressRule = DeepReadonly<z.infer<typeof egressRuleSchema>>

export type BrokerConfig = DeepReadonly<z.infer<typeof brokerSchema>>

export type ResourceLimits = DeepReadonly<z.infer<typeof resourceLimitsSchema>>

export type SessionConfig = DeepReadonly<z.infer<typeof sessionSchema>>

export type SandboxBackendId = z.infer<typeof sandboxBackendSchema>

export type AbxConfig = DeepReadonly<z.infer<typeof abxConfigSchema>>

/** 出口白名单命中的判定结果，供 broker 决定放行还是 403。 */
export interface UpstreamIndex {
  /** baseUrl 的 hostname → 上游。直通模式下用它决定注不注凭据。 */
  readonly byHost: ReadonlyMap<string, Upstream>
  readonly byId: ReadonlyMap<string, Upstream>
}
