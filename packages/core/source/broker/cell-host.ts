/**
 * 舱面地址：容器该往哪个地址打宿主上的 broker，以及 broker 该绑在哪。
 *
 * **这是两件事，混起来是 macOS 与 Windows 上舱面起不来的原因。**
 * 绑的地址必须是宿主机上真实存在的一个网卡地址；舱内打的地址必须是容器**从里面**
 * 够得着的名字。在原生 Linux docker 上这两个恰好都是 `172.17.0.1`（docker0 网桥的
 * 网关），于是「配置里写一个地址、bind 它、再把它告诉舱内」看起来能一直跑下去。
 * Docker Desktop 上没有 `172.17.0.1` 这个网卡——bind 直接 EADDRNOTAVAIL，
 * 而报错说的是「舱面起不来」，读起来像端口被占了。
 *
 * **为什么不写死一个「正确」的默认值。** 实测（见
 * `apps/docs/specs/operations/docker-verification.md` §2）三台机器上舱内能连到宿主的
 * 地址并不一样：Docker Desktop 注入 `host.docker.internal`（解析到 VM 网关），
 * 原生 linux docker 压根没有这个名字，而旧版 Docker Desktop 的 VM 网关又是
 * `192.168.65.2`。所以唯一可靠的做法是**问机器**——从舱内依次探这几条候选，
 * 取第一条真的到了舱面的。哪天 Docker 换了网关，这张表会自己跟着变，
 * 而不是让一个常量继续「通过」。
 *
 * 判定本身是**纯的**：`decideCellHost()` 只吃一个注入了 I/O 的 `CellHostProbe`，
 * 自己一个系统调用都不做。起容器去探那一层由调用方给（e2e 驱动、将来的会话编排），
 * 于是「哪条候选先被选中、都不通时说什么」这些能在没有 docker 的机器上验。
 * 形状与 `probeDocker()` / `probeUserNamespaces()` 一致。
 */

import { isIP } from 'node:net'

/**
 * 舱面地址的候选，顺序就是「先试哪个」。
 *
 *   - `host.docker.internal` —— Docker Desktop 注入的名字；原生 linux docker 上
 *     要显式补 `--add-host`（见 `HOST_GATEWAY_MAPPING`）才有；
 *   - `172.17.0.1` —— docker0 网桥的默认网关，原生 linux docker 的常规答案；
 *   - `192.168.65.2` —— 旧版 Docker Desktop 的 VM 网关，新版本已经换成
 *     `host.docker.internal`，留着是因为换机器的代价比留一行大。
 */
export const CELL_HOST_CANDIDATES: readonly string[] = ['host.docker.internal', '172.17.0.1', '192.168.65.2']

/**
 * `--add-host=<名字>:<这个>` 里的那个特殊值。
 *
 * `host-gateway` 是 docker 自己认的字面量，展开成**这台机器上容器的默认网关地址**，
 * 所以它不需要我们算出网关是几。
 *
 * **只在名字解析不出来时才加。** 在 Docker Desktop 上无条件加会把
 * `host.docker.internal` 改指到一个 IPv6 ULA 地址（实测 `fdc4:f303:9324::254`），
 * 而舱面绑的是纯 IPv4 —— 实测那次没坏，但那属于「这次没踩到」，不是「这个参数安全」。
 * 判定收在 `needsHostGatewayMapping()` 里，调用方不要自己写 `if`。
 */
export const HOST_GATEWAY_MAPPING = 'host-gateway'

/** 探测用的 I/O。都是「从**舱内**看」的视角，不是宿主自己的视角。 */
export interface CellHostProbe {
  /**
   * 这个名字在舱内解析成什么地址；解析不出来就是 `null`。
   * 对应 `docker run --rm <image> getent hosts <name>`。
   */
  resolve(host: string): Promise<string | null>
  /**
   * 从这个地址能不能打到宿主上的舱面。
   * 对应 `docker run --rm <image> node -e 'fetch("http://<host>:<port>/healthz")'`。
   *
   * 判据是「连上了」而不是「回了 200」：舱面本来就要令牌，不带令牌回 401
   * 恰恰是**通了**的证据。
   */
  reachable(host: string): Promise<boolean>
}

/** 一条候选地址探完之后的全部事实。 */
export interface CellHostAttempt {
  readonly host: string
  /** 舱内解析成什么；`null` = 这个名字在舱内不存在。 */
  readonly resolved: string | null
  readonly reachable: boolean
  /** 要补 `--add-host=<host>:host-gateway` 这个名字才解析得出来。 */
  readonly needsHostGatewayMapping: boolean
}

/**
 * 探测结论。只有两种，没有第三种「凑合用一个」。
 *
 * 探到了就是探到了（`host` 是**实测**通的地址）；一条都不通就是起不来——
 * 这时候拿随便一个地址继续跑，结果是一堆连不上的请求和一个 401，比直接失败难查得多。
 */
export type CellHostDecision =
  | { readonly kind: 'probed'; readonly host: string; readonly attempts: readonly CellHostAttempt[]; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly attempts: readonly CellHostAttempt[]; readonly detail: string }

/** 这个名字在舱内不存在，得靠 `--add-host` 补。 */
export function needsHostGatewayMapping(resolved: string | null): boolean {
  return resolved === null
}

/**
 * 依次探候选地址，取第一条**真的通了**的。
 *
 * 每条都要先解析再连：解析不出来还去连，得到的是一个语焉不详的 DNS 失败，
 * 而两种失败要给出的下一步完全不同（一个是「补 `--add-host`」，一个是
 * 「你这台机器上容器到宿主根本不通」）。所以两步都记进 `attempts`。
 *
 * 候选之间**不并行**：顺序本身就是结论的一部分（`host.docker.internal` 优先于网关，
 * 因为 Docker Desktop 上只有前者稳定），并行就没有「第一条」了。
 */
export async function decideCellHost(probe: CellHostProbe, candidates: readonly string[] = CELL_HOST_CANDIDATES): Promise<CellHostDecision> {
  const attempts: CellHostAttempt[] = []

  for (const host of candidates) {
    const resolved = await probe.resolve(host)
    const reachable = resolved === null ? false : await probe.reachable(host)
    attempts.push({ host, resolved, reachable, needsHostGatewayMapping: needsHostGatewayMapping(resolved) })
    if (reachable) {
      return {
        kind: 'probed',
        host,
        attempts,
        detail: `舱内打得通 ${host}${resolved === null ? '' : `（解析为 ${resolved}）`}`,
      }
    }
  }

  return { kind: 'unreachable', attempts, detail: cellHostFailureDetail(attempts) }
}

/**
 * 一条候选都不通时给用户看的话。
 *
 * 三分支对应三种**不同的**下一步，所以必须分开说：
 *
 *   1. 解析不出来（`needsHostGatewayMapping`）——这个名字在舱内不存在。
 *      下一步是补一条 `--add-host`，abx 自己会补。
 *   2. 解析出来了但连不上 —— 名字对，路不通。这是宿主侧的防火墙 / docker 网络模式 /
 *      VPN，不是 abx 能修的。
 *   3. 候选表整个过时 —— 这台机器用的是我们没想到的网关。要说清「这是个可以加一行的
 *      配置问题」，而不是让人去读源码。
 *
 * 一句「舱面起不来」这三种情况都盖得住，但盖住之后用户没有任何可做的事。
 */
export function cellHostFailureDetail(attempts: readonly CellHostAttempt[]): string {
  const unresolved = attempts.filter((attempt) => attempt.needsHostGatewayMapping)
  const connected = attempts.filter((attempt) => !attempt.needsHostGatewayMapping && !attempt.reachable)

  const lines = [
    '舱内一条候选地址都打不通宿主的舱面。试过：',
    ...attempts.map((attempt) => {
      if (attempt.needsHostGatewayMapping) return `  - ${attempt.host}：舱内解析不出这个名字`
      if (attempt.reachable) return `  - ${attempt.host}：通了（不该走到这里）`
      return `  - ${attempt.host}：解析为 ${attempt.resolved ?? '?'}，但连不上`
    }),
  ]

  if (connected.length === 0 && unresolved.length > 0) {
    // 全都没解析出来：`--add-host` 没补上，或者压根没起过容器。
    lines.push(
      '这几条全是「名字不存在」。容器没起来时 `--add-host` 也就没生效；' +
        '名字确实存在但解析不出来的话，请把候选地址里加上这台机器上真实的那个网关（docker network inspect bridge）。',
    )
  } else if (unresolved.length === 0) {
    lines.push(
      '名字都解析出来了、一条都连不上，说明这台机器上「容器 → 宿主」这条链路不通：' +
        '宿主防火墙、docker 网络模式（host 模式下不能用网桥地址）、VPN 都可能。' +
        '这不是 abx 能修的，abx 也**不会**拿一个连不上的地址继续起会话。',
    )
  } else {
    lines.push(
      '有的是名字不存在、有的是名字对但连不上。请先确认容器和宿主在同一个 docker 网络里，' +
        '再检查宿主防火墙有没有拦住容器网段。',
    )
  }

  lines.push(
    '要固定一个地址，在配置里写 broker.cellHost，或者起会话时用 --cell-host —— ' +
      '写死之后 abx 就不再探测了。',
  )

  return lines.join('\n')
}

/**
 * 舱面该 bind 在哪。
 *
 * `local` 后端跑在宿主上，能连到它的就是回环，绑 `127.0.0.1` 最窄；
 * docker 后端要能被容器够到，绑哪由**探测**决定：先试配置里那个（在原生 linux docker
 * 上是真实网卡，最窄），不行再退到 `0.0.0.0`。
 *
 * **顺序不能反。** 反过来（默认就绑 `0.0.0.0`）在 Linux 上把舱面摊到了所有网卡上，
 * 而那里本来有一个更窄的地址可用；而 `0.0.0.0` 是必须留着的退路——Docker Desktop
 * 上除了它没有别的选择（见 docker-verification §2）。
 *
 * **名字不能当 bind 候选。** 配置里默认那个 `host.docker.internal` 是**舱内的**名字，
 * 它在宿主上解析成什么、解析不解析得出来，跟容器里完全无关；拿它去 `listen()` 要么
 * EADDRNOTAVAIL 要么绑到一张我们没想过的网卡上。所以只有**字面 IP**才配进候选表，
 * 名字一律直接走 `0.0.0.0`——这也正是 Docker Desktop 上实测能用的那一个
 * （docker-verification §2：`ss -ltn` 里是 `0.0.0.0:28732`）。
 *
 * 判据用 `net.isIP` 而不是「名字里有没有点」：`isIP` 是纯字符串判断、不查 DNS，
 * 三个平台上同一份行为，所以这一条在 Linux 上也验得了。
 */
export interface BindHostCandidatesInput {
  readonly backend: 'local' | 'docker'
  readonly configuredHost: string
  readonly override?: string | null
}

export function bindHostCandidates(input: BindHostCandidatesInput): readonly string[] {
  if (input.override !== null && input.override !== undefined && input.override !== '') return [input.override]
  if (input.backend === 'local') return ['127.0.0.1']
  if (input.configuredHost === '0.0.0.0') return ['0.0.0.0']
  if (isIP(input.configuredHost) !== 0) return [input.configuredHost, '0.0.0.0']
  return ['0.0.0.0']
}
