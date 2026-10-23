/**
 * 整份配置的 zod schema —— 配置形状的**唯一真相**。
 *
 * 迁移之前，同一条规则写三遍：`config.ts` 里手写 interface、`load-config.ts` 里逐个
 * 字段校验、`readers.ts` 里取值加报错文案。加一个字段要同时改三处，漏掉任何一处
 * 都会得到「类型允许但校验拒绝」这种最难查的不一致。现在只写在这里：
 * 类型从 schema 推（见 `config.ts`），校验直接跑 schema（见 `load-config.ts`）。
 *
 * 两条写法上的约定：
 *
 *   1. **报错文案不把值原样倒出来**，长字符串只说长度（见 `describe`）——出问题的
 *      那个值有可能就是秘密，报错信息自己不能变成泄漏渠道。
 *   2. **默认值写在字段上，不给整段对象写 `.default({...})`**：zod 把 `.default()`
 *      的值**原样**当成结果，不会再跑一遍内层 schema，于是字段级默认值一个都不生效，
 *      缺的字段会静默变成 `undefined`（见 `withFieldDefaults`）。
 */

import { z } from 'zod'
import { parseDomainPattern } from './domain-pattern'

// ---------------------------------------------------------------------------
// 取值与文案
// ---------------------------------------------------------------------------

/** 报错文案里描述一个值，但不把长字符串原样倒出来——它有可能就是那个秘密。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'string') {
    return value.length <= 24 ? JSON.stringify(value) : `一个 ${value.length} 字符的字符串`
  }
  return typeof value
}

/**
 * zod 把出错的那个值放在 `input` 上。
 *
 * 报错文案只需要它——`path` 由 `load-config.ts` 拼，别的字段（期望类型、下界……）
 * 都已经被我们自己的文案替掉了。
 */
interface IssueInput {
  readonly input: unknown
}

/** 类型不对时的文案：「期望 X，实际是 Y」。 */
function expected(what: string): (issue: IssueInput) => string {
  return (issue) => `期望${what}，实际是 ${describe(issue.input)}`
}

function stringField(): z.ZodString {
  return z.string({ error: expected('一个字符串') })
}

/**
 * 记一条自定义问题，并显式标上「记完接着往下查」。
 *
 * `continue: true` 不是装饰：不标的 issue 会被 zod 当成「到此为止」，于是**这个
 * schema 之后的 check 会跳过，挂在它外面那一层的 `.check()` 也会跳过**。表现
 * 就是「上游的 baseUrl 写错了，于是同一个上游『凭据来源没写』那条干脆不报」——
 * 而一次收齐全部问题正是这个项目要的东西。`.refine()` 内部也是这么打的标记，
 * 这里只是把同样的事搬到需要自定义文案的地方。
 */
function customIssue(input: unknown, message: string, path: readonly PropertyKey[] = []): z.core.$ZodRawIssue {
  return { code: 'custom', input, message, path: [...path], continue: true }
}

/**
 * 「可以不配」的字符串。
 *
 * 缺省和 `null` 都算没配，但写了个空串算错：空串几乎总是「复制了样例、忘了填」，
 * 而它的表现是运行时一个空的环境变量名、一个空的路径，比启动时报错难查得多。
 */
function optionalString(): z.ZodType<string | null> {
  return stringField().min(1, '不能为空').nullable().default(null)
}

/**
 * 字段级默认值：缺省**和 `null`** 都取 fallback。
 *
 * 为什么不用 zod 的 `.default()`：它只认 `undefined`，而 JSON 里根本没有
 * `undefined`——「这个键我不填」只能写成 `null`。迁移前那边是一路
 * `object['x'] ?? 默认值`，即 `null` 与缺省等价；换成 `.default()` 的话，
 * 一份写了 `"hostPort": null` 的配置会因为一次重构突然起不来。语义按老规矩来，
 * 想改成「写了 null 就报错」是另一件事，不该夹在迁移里。
 */
function orDefault<Schema extends z.ZodType>(schema: Schema, fallback: z.output<Schema>): z.ZodType<z.output<Schema>> {
  return z.optional(z.nullable(schema)).transform((value) => value ?? fallback)
}

/**
 * 把「看起来是数字的字符串」还原成数字。
 *
 * 必须有这一步，因为环境变量展开的结果**永远是字符串**：`"hostPort": "${ABX_PORT}"`
 * 展开出来是 `"8123"`，不是 `8123`。没有这层还原的话，配置文件里所有
 * 「端口 / 限额之类想用环境变量控制」的字段都是写了就报错，
 * 而报错信息（「期望一个整数，实际是 "8123"」）看起来还像是用户写错了。
 *
 * 只认完整的数字字面量：`"80abc"` 不认，`""` 也不认——宽松到能把 `Number()` 那套
 * `"" → 0`、`"0x10" → 16` 的怪癖放进来，配置里的 typo 就会变成静默的错值。
 */
function coerceNumericString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value
  return Number(trimmed)
}

interface RangeOptions {
  readonly min?: number
  readonly max?: number
}

interface NumberFieldOptions extends RangeOptions {
  /** 是否必须是整数。整数和数字要说的不是一句话，所以这个开关同时决定文案。 */
  readonly integer?: boolean
}

/** 数字字段：先还原数字字符串，再看整数性与范围。 */
function numberField(options: NumberFieldOptions = {}): z.ZodType<number> {
  const { min, max, integer = false } = options
  return z.preprocess(
    coerceNumericString,
    z
      .number({ error: expected(integer ? '一个整数' : '一个数字') })
      .refine((value) => !integer || Number.isInteger(value), '必须是整数')
      .refine((value) => min === undefined || value >= min, `不能小于 ${min}`)
      .refine((value) => max === undefined || value <= max, `不能大于 ${max}`),
  )
}

function intField(options: RangeOptions = {}): z.ZodType<number> {
  return numberField({ ...options, integer: true })
}

/**
 * 整段缺省时喂一个空对象进去，让下面各字段自己的 `.default()` 生效。
 *
 * 不能换成 `.default({})`：zod 把 `.default()` 的值原样当成结果，不再跑内层 schema，
 * 结果是「配置里不写 broker 段」反而比「写一个空的 broker 段」少了一大半字段，
 * 而这种缺字段只在真正用到它的那一行才炸。
 */
function withFieldDefaults<Schema extends z.ZodType>(schema: Schema): z.ZodType<z.output<Schema>> {
  return z.preprocess((value: unknown) => (value === undefined ? {} : value), schema)
}

/** 一组值里重复出现的那些，每个只留一次。 */
function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value)
    seen.add(value)
  }
  return [...duplicated]
}

/** 试解析一个 URL。schema 拿它校验 `baseUrl`，交叉校验拿它取 hostname。 */
export function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 宿主面绑定地址。
 *
 * 恒定在回环上，且**不给配**：宿主面不校验令牌，绑到别处等于把一个不校验身份的
 * 管理面挂到网络上。配置里写了别的值也不生效——迁移前就是这个行为，重构不顺手
 * 改语义（要改成「写了别的值直接报错」是另一件事，值一条 changelog）。
 */
const HOST_FACE_ADDRESS: string = '127.0.0.1'

/** 环境变量名的写法，按 POSIX 的规矩来。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 舱内那个 home 的默认值。
 *
 * abx 的 agent 镜像目前都以 `node:22-slim` 为基础，那里 uid 1000 是 `node` 用户，
 * 它的 home 就是这里，而 `session.user` 默认也正是 `1000:1000`。**镜像是按 agent
 * 给的**，所以换上一个 uid 或 home 不同的镜像时，这两处要一起改——否则历史会写到
 * 舱内一个没人读的目录里。写成一个常量而不是在 schema 里直接写字面量，是因为
 * **别处也要用它**：生成 agent 配置时展开 `~/.claude/...` 用的就是这个值
 * （见 `core/session/agent-config.ts`），两处写两遍迟早会漂。
 */
export const DEFAULT_CELL_HOME = '/home/node'

// ---------------------------------------------------------------------------
// broker
// ---------------------------------------------------------------------------

const brokerSchema = withFieldDefaults(
  z
    .object(
      {
        // 宿主面不校验令牌，所以只能待在回环上。
        host: z.unknown().optional().transform((): string => HOST_FACE_ADDRESS),
        /** 宿主面端口：给宿主桌面客户端（第二阶段）用。 */
        hostPort: orDefault(intField({ min: 1, max: 65535 }), 8788),
        /** 舱面绑定地址。默认是 docker 网桥网关，local 后端下会被改成回环。 */
        cellHost: orDefault(stringField().min(1, '不能为空'), '172.17.0.1'),
        /** 舱面端口。 */
        cellPort: orDefault(intField({ min: 1, max: 65535 }), 8789),
        /** 舱令牌从哪个环境变量读。 */
        cellTokenEnv: orDefault(
          stringField().refine((value) => ENV_NAME_PATTERN.test(value), '要写环境变量名，不是令牌本身'),
          'ABX_CELL_TOKEN',
        ),
        /**
         * 是否接受 `/c/<token>/...` 这种把令牌写进路径的形态。
         *
         * 打开是因为真实的 agent 命令行未必能加自定义请求头（`X-Abx-Cell`），
         * 没有它 `abx open` 就只能跑一个不存在的 agent。代价是令牌会出现在 URL 里，
         * 舱内的 agent 有可能会把它写进自己的日志——那本来也是我们自己发出去的令牌，
         * 泄漏它不等于泄漏任何真实凭据，但仍然不如请求头干净。
         */
        allowCellTokenInPath: orDefault(
          z.boolean({ error: (issue: IssueInput): string => `期望 true 或 false，实际是 ${describe(issue.input)}` }),
          true,
        ),
        /** 审计流水落盘位置。 */
        auditPath: orDefault(stringField().min(1, '不能为空'), './abx-audit.jsonl'),
        /** 单次转发的超时。 */
        requestTimeoutMs: orDefault(intField({ min: 1 }), 120_000),
      },
      { error: expected('一个对象') },
    )
    // 两个面绑同一个地址端口，第二个 listen 会 EADDRINUSE，而报错只会在启动时才出现。
    .check((ctx) => {
      const { hostPort, cellPort } = ctx.value
      if (hostPort === cellPort) {
        ctx.issues.push(customIssue(ctx.value, `不能和 broker.hostPort 相同（都是 ${hostPort}）`, ['cellPort']))
      }
    }),
)

// ---------------------------------------------------------------------------
// upstreams
// ---------------------------------------------------------------------------

const upstreamSchema = z
  .object(
    {
      /** 路由里的那一段：`/u/<id>/...`。 */
      id: stringField().refine(
        (value) => /^[a-z0-9][a-z0-9-]*$/.test(value),
        '只能用小写字母、数字和连字符，且以字母或数字开头（它会出现 URL 里）',
      ),
      /** 目标地址，必须带协议，例如 `https://api.anthropic.com`。 */
      baseUrl: stringField().check((ctx) => {
        const parsed = tryParseUrl(ctx.value)
        if (parsed === null) {
          ctx.issues.push(customIssue(ctx.value, `不是合法的 URL：${JSON.stringify(ctx.value)}`))
          return
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          ctx.issues.push(customIssue(ctx.value, `只支持 http / https，实际是 ${parsed.protocol}`))
        }
      }),
      /** 要覆盖的请求头，例如 `authorization`。 */
      authHeader: stringField().refine(
        (value) => /^[A-Za-z0-9-]+$/.test(value),
        '要写 HTTP 头的名字，例如 authorization',
      ),
      /** 头里密钥前面的方案，例如 `Bearer`；`null` 表示裸放密钥。 */
      authScheme: optionalString(),
      /**
       * 凭据所在的环境变量名。与 `secretFile` 二选一，且必须选一个。
       *
       * 不套 `optionalString()`：空串本来就被变量名正则拦下，再叠一条「不能为空」
       * 只会让同一个值报出两条问题，读的人还得自己判断它们是不是两件事。
       */
      secretEnv: stringField()
        .nullable()
        .default(null)
        .refine((value) => value === null || ENV_NAME_PATTERN.test(value), '要写环境变量名，不是密钥本身'),
      /** 凭据所在的文件路径。与 `secretEnv` 二选一，且必须选一个。 */
      secretFile: optionalString(),
    },
    { error: expected('一个对象') },
  )
  // 凭据来源必须恰好一个。两个都写，读代码的人无法判断哪个生效；
  // 一个都不写，这个上游转发出去就是匿名请求，多半不是本意。
  .check((ctx) => {
    const { secretEnv, secretFile } = ctx.value
    if (secretEnv === null && secretFile === null) {
      ctx.issues.push(customIssue(ctx.value, '必须提供 `secretEnv`（环境变量名）或 `secretFile`（文件路径）之一'))
    }
    if (secretEnv !== null && secretFile !== null) {
      ctx.issues.push(customIssue(ctx.value, '`secretEnv` 和 `secretFile` 只能写一个'))
    }
  })

const upstreamsSchema = z
  .array(upstreamSchema, { error: expected('一个数组') })
  .check((ctx) => {
    for (const id of findDuplicates(ctx.value.map((upstream) => upstream.id))) {
      ctx.issues.push(customIssue(ctx.value, `上游 id 重复：${id}`))
    }
  })
  .default([])

// ---------------------------------------------------------------------------
// egress
// ---------------------------------------------------------------------------

/**
 * 存归一化之后的形式：匹配时不必再解析一次，也避免 `EXAMPLE.com` 和
 * `example.com` 在配置里看起来是两条规则。
 */
function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase()
}

const egressPatternSchema = stringField().check((ctx) => {
  const parsed = parseDomainPattern(ctx.value)
  if (!parsed.ok) {
    ctx.issues.push(customIssue(ctx.value, parsed.reason))
  }
})

/**
 * 白名单的一条，两种写法：
 *
 *   `"api.example.com"`                          直通：剥掉占位符原样转发
 *   `{ "pattern": "...", "upstreamId": "..." }`  绑凭据：转发时注入这个上游的凭据
 *
 * 前者够用且短，后者才需要绑凭据——所以 `upstreamId` 缺省是 `null`（直通），
 * 而不是「必须写」。
 */
const egressRuleSchema = z.union([
  egressPatternSchema.transform((pattern) => ({ pattern: normalizePattern(pattern), upstreamId: null })),
  z.object(
    {
      pattern: egressPatternSchema.transform(normalizePattern),
      upstreamId: optionalString(),
    },
    { error: expected('一个对象') },
  ),
])

/**
 * `egress.allow`。
 *
 * 白名单挂在 `egress.allow` 下而不是直接放在 `egress`，是为了给以后留位置：
 * `egress` 迟早要有 `deny`、`proxy`、`maxBodyBytes` 这些兄弟字段，而
 * 「egress 本身就是一个数组」这个形状一旦定下来就改不动了。
 *
 * 不写就是空名单。空名单的语义是**全部拒绝**，不是全部放行——这条默认值本身
 * 就是一道防线，值得写一行注释钉住。
 *
 * 最后那步 `transform` 是形状上的：`egress` 段只为了给以后留兄弟字段而存在，
 * 出去的一律是那条 `allow` 名单本身，读配置的人不必处处写 `.egress.allow`。
 */
const egressSchema = withFieldDefaults(
  z.object(
    {
      allow: z
        .array(egressRuleSchema, { error: expected('一个数组') })
        .check((ctx) => {
          for (const pattern of findDuplicates(ctx.value.map((rule) => rule.pattern))) {
            ctx.issues.push(customIssue(ctx.value, `域名重复：${pattern}`))
          }
        })
        .default([]),
    },
    { error: expected('一个对象') },
  ),
).transform((section) => section.allow)

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export const sandboxBackendSchema = z.enum(['docker', 'local'], {
  error: (issue: IssueInput): string => `只支持 "docker" 或 "local"，实际是 ${describe(issue.input)}`,
})

const resourceLimitsSchema = withFieldDefaults(
  z.object(
    {
      /** docker `--memory`，例如 `2g`。 */
      memory: orDefault(
        stringField().refine((value) => /^\d+[bkmgBKMG]?$/.test(value), 'docker 的写法，例如 2g / 512m'),
        '2g',
      ),
      /** docker `--pids-limit`。 */
      pids: orDefault(intField({ min: 1 }), 256),
      /** docker `--cpus`。 */
      cpus: orDefault(numberField({ min: 0.01 }), 2),
    },
    { error: expected('一个对象') },
  ),
)

const sessionSchema = withFieldDefaults(
  z.object(
    {
      // 默认必须是 docker。默认 local 等于默认没有沙箱，
      // 而「默认不安全」是这类工具最不该有的性质。
      backend: orDefault(sandboxBackendSchema, 'docker'),
      /**
       * docker 镜像。**可选**：不写就用所选 agent 清单里那个（`AgentDefinition.image`）。
       *
       * 镜像本来就是 agent 的性质——`command: 'claude'` 在一个没有装 claude 的镜像里
       * 起不来，而会话看起来「起来了」，其实什么都干不了。默认值写死成某个裸镜像，
       * 等于让每个新 agent 都被它悄悄盖掉。
       *
       * 显式写仍然有效，而且是有用的：只跑一个裸容器（例如 `node:22-slim`）做网络/挂载
       * 验证时，没道理为它登记一条 agent 清单。这句话就是那个出口。
       */
      image: optionalString(),
      /** 舱内以哪个用户跑。非 root。 */
      user: orDefault(stringField().min(1, '不能为空'), '1000:1000'),
      /** docker 网络。 */
      network: orDefault(stringField().min(1, '不能为空'), 'bridge'),
      /** 任务目录挂进舱内后的路径。 */
      workdir: orDefault(
        stringField().refine((value) => value.startsWith('/'), '必须是舱内的绝对路径，例如 /workspace'),
        '/workspace',
      ),
      /**
       * **舱内**那个 home，不是宿主上的 home。
       *
       * 它决定两件事，两件都必须跟着它走：
       *   1. `--env HOME=` 注入什么（不依赖镜像默认值）；
       *   2. 注册表里 `~/.claude/settings.json` 这类路径展开到哪儿 ——
       *      展开成宿主 home 的话，生成的配置会落在舱内 agent 根本不会读的地方。
       *
       * 默认值等于 `node:22-slim` 里 uid 1000 那个用户的 home，与 `user` 的默认值配套。
       * 换镜像换了 uid 时，这个值要跟着改；它是配置，不是猜出来的。
       */
      cellHome: orDefault(
        stringField().refine((value) => value.startsWith('/'), '必须是舱内的绝对路径，例如 /home/node'),
        DEFAULT_CELL_HOME,
      ),
      limits: resourceLimitsSchema,
      /** `/tmp` 的 tmpfs 大小（MB）；舱内根文件系统只读，可写的地方只有这里和任务目录。 */
      tmpfsSizeMb: orDefault(intField({ min: 1 }), 64),
    },
    { error: expected('一个对象') },
  ),
)

// ---------------------------------------------------------------------------
// 整份配置
// ---------------------------------------------------------------------------

/**
 * 整份配置。
 *
 * 未知字段一律丢弃（zod 的默认行为），与迁移前一致——`$comment` 之类的注释键
 * 在更早的一步（`expandEnvTree`）就已经摘掉了，这里丢掉的是没人认识的键。
 */
export const abxConfigSchema = z.object(
  {
    broker: brokerSchema,
    upstreams: upstreamsSchema,
    egress: egressSchema,
    session: sessionSchema,
  },
  { error: expected('一个对象') },
)

export { brokerSchema, egressRuleSchema, resourceLimitsSchema, sessionSchema, upstreamSchema }
