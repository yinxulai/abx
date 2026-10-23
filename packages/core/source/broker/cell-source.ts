/**
 * 舱面的第二道闸：来源网段校验。
 *
 * 为什么需要它：舱面在 Docker Desktop 上**必须**绑 `0.0.0.0`（网桥网关活在 VM 里，
 * 宿主根本绑不上），于是「谁能连上」这件事不再由内核的 bind 地址收窄——局域网上
 * 任何机器都能连到舱面。令牌只补了一半，而令牌**一定会被打印出来**：它就在舱内
 * agent 的 `BASE_URL` 里，agent 复述配置、报错、把 URL 贴进 issue 都是常规操作。
 * 一份会出现在终端输出里的凭据，不能是唯一的门。
 *
 * 这里把丢掉的那道门换个位置装回来：**只认 docker 的网桥 / VM 网段**，
 * 网段外即便令牌正确也拒绝。判据是连接的对端地址（`remoteAddress`），
 * 不是任何请求头——请求头是请求方自己能写的。
 *
 * 四个刻意的选择：
 *
 *   1. **拿不到来源地址就拒绝。** 判不出来的时候，「允许」是错的方向：拿不到地址
 *      只可能是底层出了问题，那种情况下放行等于这道闸不存在。
 *   2. **允许列表为空 = 全部拒绝。** 结果同为拒绝，但拒因分开（`no-subnets` 与
 *      `outside-subnets`），否则事后分不清是「配置漏了」还是「真的有人在打」。
 *   3. **只支持 IPv4 CIDR。** 舱面绑的是纯 IPv4 地址（`0.0.0.0` 或网桥地址），
 *      来源也只会是 IPv4。真 IPv6 的来源没有可比的网段，判成 `unsupported-address`
 *      这种明确的「判不了」，而不是悄悄放过（见 1）。
 *   4. **畸形条目按「不匹配」处理，不抛异常。** 这条跑在每个请求上，一个写错的
 *      配置不该把请求处理路径炸掉。它落在「不匹配」这一侧，也就是失败方向是关的；
 *      调用方可以用 {@link findInvalidCellSubnets} 在启动时把写错的条目喊出来。
 *
 * 纯函数：不碰网络、不读配置。`server.ts` 把 `request.socket.remoteAddress` 递进来。
 */

/** 回环网段。默认列表里有它，理由见 {@link DEFAULT_ALLOWED_CELL_SUBNETS}。 */
export const LOOPBACK_SUBNET = '127.0.0.1/32'

/**
 * 默认允许的来源网段。
 *
 *   - `192.168.65.0/24` Docker Desktop 在 VM 里的宿主网关（`host.docker.internal`）
 *   - `172.17.0.0/16`   Linux 上 docker 默认网桥（舱从容器 IP 打过来）
 *   - `127.0.0.1/32`    宿主回环
 *
 * **第三条是实测逼出来的，不是抄设计文档来的。** §19.1 只写了前两条，前提是
 * 「舱从 docker 网段打过来，所以网段外的一律是外人」。这个前提在 Docker Desktop
 * 上不成立：它的端口转发把「容器 → 宿主」的连接**落在宿主自己的回环上**。实测
 * （docker server 29.9.1 / Docker Desktop for Linux，宿主进程绑 `0.0.0.0`）：
 *
 *   容器 fetch host.docker.internal:<port>  → 宿主看到 remoteAddress = 127.0.0.1
 *   容器 fetch 192.168.65.2:<port>          → 宿主看到 remoteAddress = 127.0.0.1
 *   容器 fetch <宿主 LAN IP>:<port>         → 宿主看到 remoteAddress = <宿主 LAN IP>
 *   宿主只绑 127.0.0.1 时，容器照样连得上
 *
 * 也就是说：**在 Docker Desktop 上，容器和宿主本机进程在 `remoteAddress` 上无法区分**，
 * 少了 `127.0.0.1/32` 这一条，舱**一个请求都进不来**（真 docker 脚本上表现为
 * 满屏 403 `abx_cell_source_denied`）。设计文档里那条「网段外即便令牌正确也拒绝」
 * 在这块平台上只能做到它的**目的**，做不到它的字面：
 *
 *   目的（保留）：局域网上别的机器打不进来——它们走的是普通内核路径，
 *                 来源地址就是它们自己的地址，落不进上面三条。
 *   字面（做不到）：把「宿主本机进程」也挡在外面——Docker Desktop 上它和容器同源。
 *
 * 少掉的那半由令牌补回来（令牌仍然必须有效），这也是 `token.ts` 存在的原因。
 * 等 `broker.allowedCellSubnets` 配置项落地时，这段判断要连同实测一起搬到文档里。
 *
 * **这是配置项 `broker.allowedCellSubnets` 的默认值，暂时只能从 `BrokerOptions`
 * 覆盖。** 配置层（`packages/contracts/source/config.ts` 的 `BrokerConfig` +
 * `load-config.ts` 的解析）合并之后，这个常量的落点改成读配置、由配置层给默认值；
 * 在那之前，别为了塞这个字段去动 `packages/contracts/**`。
 */
export const DEFAULT_ALLOWED_CELL_SUBNETS: readonly string[] = ['192.168.65.0/24', '172.17.0.0/16', LOOPBACK_SUBNET]

/** 判定结果。拒绝的几种原因是分开的：事后要靠它区分「没配」和「有人在打」。 */
export type CellSourceReason =
  /** 来源在允许列表里。 */
  | 'allowed'
  /** 连接上没有对端地址。判不了 → 拒绝。 */
  | 'no-address'
  /** 允许列表是空的（或者一条都没解析成功）→ 全部拒绝。 */
  | 'no-subnets'
  /** 来源不是 IPv4（或不是合法地址），跟 IPv4 网段没有可比性。 */
  | 'unsupported-address'
  /** 来源是 IPv4，但不在任何一条允许的网段里。 */
  | 'outside-subnets'

export interface CellSourceCheck {
  readonly allowed: boolean
  readonly reason: CellSourceReason
  /** 归一化之后的来源地址（IPv4-mapped IPv6 已还原成 IPv4）；拿不到就是 `null`。 */
  readonly address: string | null
}

/**
 * 来源地址归一化。
 *
 * 主要处理 IPv4-mapped IPv6：双栈监听（`0.0.0.0` 同时也吃 IPv6）上，同一个来源
 * 会因为内核选哪套栈而报成 `::ffff:192.168.65.2` 或 `192.168.65.2`。不归一化的话，
 * 同一台机器在网段判定上会给出两个结果——这正是那种「本机好用、同事机器上 403」
 * 的问题。IPv4 的写法也顺手规范化（`010` 之类见 {@link parseIpv4}）。
 *
 * 拿不到（`undefined` / 空串）返回 `null`，由调用方判成拒绝。
 */
export function normalizeRemoteAddress(remoteAddress: string | undefined): string | null {
  if (remoteAddress === undefined) return null
  const trimmed = remoteAddress.trim()
  if (trimmed === '') return null

  // 链路本地地址可能带 scope（`fe80::1%eth0`）。scope 是接口名，不是地址的一部分。
  const scopeAt = trimmed.indexOf('%')
  const unscoped = scopeAt === -1 ? trimmed : trimmed.slice(0, scopeAt)

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unscoped)
  const candidate = mapped?.[1] ?? unscoped
  const octets = parseIpv4(candidate)
  if (octets === null) return unscoped.toLowerCase()

  return formatIpv4(octets)
}

/**
 * 这个地址是不是回环。
 *
 * 给调用方用的：舱面绑在回环上时，允许列表要把回环放进去，否则一个请求都进不来
 * （绑回环时内核本来就只让回环连进来，多这一条不会让「谁能连上」变宽）。
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeRemoteAddress(address)
  if (normalized === null) return false
  if (normalized === '::1') return true

  const octets = parseIpv4(normalized)
  // 整个 127.0.0.0/8 都是回环，不只是 127.0.0.1。
  return octets !== null && (octets >>> 24) === 127
}

/** 判定来源，给出拒因。`server.ts` 用它写审计里的决策。 */
export function classifyCellSource(remoteAddress: string | undefined, allowedSubnets: readonly string[]): CellSourceCheck {
  const address = normalizeRemoteAddress(remoteAddress)
  if (address === null) return { allowed: false, reason: 'no-address', address: null }

  const networks = allowedSubnets.map(parseCidr).filter((network): network is Ipv4Cidr => network !== null)
  if (networks.length === 0) return { allowed: false, reason: 'no-subnets', address }

  const value = parseIpv4(address)
  if (value === null) return { allowed: false, reason: 'unsupported-address', address }

  const hit = networks.some((network) => ((value & network.mask) >>> 0) === network.network)
  return { allowed: hit, reason: hit ? 'allowed' : 'outside-subnets', address }
}

/**
 * 来源是否被允许。
 *
 * 只要「是 / 否」的调用方用这个；要区分拒因的用 {@link classifyCellSource}。
 */
export function isAllowedCellSource(remoteAddress: string | undefined, allowedSubnets: readonly string[]): boolean {
  return classifyCellSource(remoteAddress, allowedSubnets).allowed
}

/**
 * 列表里解析不出来的条目。
 *
 * 它们不影响判定（见文件头第 4 条），但**必须能被人看见**：一条写错的网段
 * 表现出来是「全都 403」，没有别的线索。`startBroker` 在启动时拿它打警告。
 */
export function findInvalidCellSubnets(allowedSubnets: readonly string[]): readonly string[] {
  return allowedSubnets.filter((entry) => parseCidr(entry) === null)
}

interface Ipv4Cidr {
  /** 网络地址（已按掩码对齐），uint32。 */
  readonly network: number
  /** 掩码，uint32。 */
  readonly mask: number
}

/**
 * 解析一条允许的网段。
 *
 * 裸地址（`192.168.65.2`）按 `/32` 处理：它是一个精确的地址，不是「整段都放行」，
 * 失败方向不会因此变松，而少写一个 `/32` 是很自然的手误。
 *
 * 网络号带主机位（`192.168.65.7/24`）按标准做法对齐到网络地址，不当成错误。
 */
function parseCidr(entry: string): Ipv4Cidr | null {
  const text = entry.trim()
  if (text === '') return null

  const slash = text.indexOf('/')
  const addressPart = slash === -1 ? text : text.slice(0, slash)
  const prefixPart = slash === -1 ? '32' : text.slice(slash + 1)
  // 位数和前缀都按严格写法认：`+4`、`4.0`、`24/8` 一律判非法。
  if (!/^\d{1,2}$/.test(prefixPart)) return null

  const prefix = Number(prefixPart)
  if (prefix > 32) return null

  const address = parseIpv4(addressPart)
  if (address === null) return null

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { network: (address & mask) >>> 0, mask }
}

/** 点分四段 → uint32。不合法返回 `null`。 */
function parseIpv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    // 前导零（`010`）在别的实现里可能是八进制，含义不唯一。判成非法，
    // 免得出现「配置里写的是 10、判定按 8 走」这种没人能一眼看出来的偏差。
    if (part.length > 1 && part.startsWith('0')) return null

    const octet = Number(part)
    if (octet > 255) return null
    result = (result << 8) | octet
  }
  return result >>> 0
}

function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.')
}
