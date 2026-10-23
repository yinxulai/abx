import { describe, expect, it } from 'vitest'
import {
  CELL_HOST_CANDIDATES,
  HOST_GATEWAY_MAPPING,
  bindHostCandidates,
  decideCellHost,
  needsHostGatewayMapping,
  type CellHostProbe,
} from './cell-host'

/*
 * 这份测试一个 docker 都不用起：探测那一半的 I/O 全在 `CellHostProbe` 里注入进来，
 * 所以「哪条候选先被选中、都不通时说什么、`--add-host` 什么时候才加」这些判定
 * 在没有 docker 的机器上就能完整跑一遍。这也正是当初把判定与 I/O 分开的原因——
 * 这台开发机上没有 Docker Desktop，「Docker Desktop 上会怎样」只能这样验。
 */

/** 一条候选在一张假表里的样子。 */
interface FakeEntry {
  readonly resolved: string | null
  readonly reachable: boolean
}

/** 一个假的舱内视角：名字能解析出什么、解析出来的地址通不通，都摆在一张表里。 */
function fakeProbe(table: Readonly<Record<string, FakeEntry>>): CellHostProbe {
  const seen: string[] = []
  const probe: CellHostProbe & { readonly seen: readonly string[] } = {
    seen,
    async resolve(host) {
      seen.push(`resolve:${host}`)
      return table[host]?.resolved ?? null
    },
    async reachable(host) {
      seen.push(`reachable:${host}`)
      return table[host]?.reachable ?? false
    },
  }
  return probe
}

describe('decideCellHost · 三种结局', () => {
  it('结局一：host.docker.internal 通 —— 就是它，后面的候选一个都不试', async () => {
    const probe = fakeProbe({
      'host.docker.internal': { resolved: '192.168.65.254', reachable: true },
      '172.17.0.1': { resolved: '172.17.0.1', reachable: true },
    })

    const decision = await decideCellHost(probe)

    expect(decision.kind).toBe('probed')
    expect(decision.kind === 'probed' ? decision.host : null).toBe('host.docker.internal')
    expect(decision.kind === 'probed' ? decision.detail : '').toContain('192.168.65.254')
    // 顺序是结论的一部分：第一条通了就不该再去连第二条。
    expect((probe as CellHostProbe & { seen: readonly string[] }).seen).toEqual([
      'resolve:host.docker.internal',
      'reachable:host.docker.internal',
    ])
  })

  it('结局二：第一个名字解析不出来，退到网桥网关 —— 而且记下「这个名字要补 --add-host」', async () => {
    // 原生 linux docker 的真实样子：没有 host.docker.internal，有 172.17.0.1。
    const probe = fakeProbe({
      '172.17.0.1': { resolved: '172.17.0.1', reachable: true },
    })

    const decision = await decideCellHost(probe)

    expect(decision.kind === 'probed' ? decision.host : null).toBe('172.17.0.1')
    expect(decision.attempts).toHaveLength(2)
    expect(decision.attempts[0]).toEqual({
      host: 'host.docker.internal',
      resolved: null,
      reachable: false,
      needsHostGatewayMapping: true,
    })
    expect(decision.attempts[1]?.needsHostGatewayMapping).toBe(false)
  })

  it('名字解析不出来就**不去连**——那只会得到一个语焉不详的 DNS 失败', async () => {
    const probe = fakeProbe({ '172.17.0.1': { resolved: '172.17.0.1', reachable: true } })
    await decideCellHost(probe)

    const seen = (probe as CellHostProbe & { seen: readonly string[] }).seen
    expect(seen).toContain('resolve:host.docker.internal')
    expect(seen).not.toContain('reachable:host.docker.internal')
  })

  it('结局三：一条都不通 —— 不挑一个凑合用，直接给出结论和下一步', async () => {
    const probe = fakeProbe({
      '172.17.0.1': { resolved: '172.17.0.1', reachable: false },
      '192.168.65.2': { resolved: '192.168.65.2', reachable: false },
    })

    const decision = await decideCellHost(probe)

    expect(decision.kind).toBe('unreachable')
    if (decision.kind !== 'unreachable') return
    expect(decision.attempts).toHaveLength(CELL_HOST_CANDIDATES.length)
    // 「不挑一个凑合用」是这条的实质：结论里没有 host 可用。
    expect(decision.detail).not.toContain('用 172.17.0.1')
    expect(decision.detail).toContain('一条候选地址都打不通')
  })

  it('候选表变了也不影响判定——顺序是参数，不是写死的', async () => {
    const probe = fakeProbe({ '10.9.9.9': { resolved: '10.9.9.9', reachable: true } })
    const decision = await decideCellHost(probe, ['10.9.9.9', '172.17.0.1'])

    expect(decision.kind === 'probed' ? decision.host : null).toBe('10.9.9.9')
    expect(decision.attempts).toHaveLength(1)
  })
})

describe('都不通时说的话', () => {
  it('全是「名字不存在」时，指向 --add-host 和候选表', async () => {
    const decision = await decideCellHost(fakeProbe({}))
    const detail = decision.detail

    expect(detail).toContain('host.docker.internal：舱内解析不出这个名字')
    expect(detail).toContain('--add-host')
    expect(detail).toContain('docker network inspect bridge')
  })

  it('名字都解析得出来却连不上时，明说这是宿主侧的事、不是 abx 能修的', async () => {
    // 三条都解析得出来（包括 host.docker.internal），一条都连不上。
    const probe: CellHostProbe = { async resolve(host) { return host }, async reachable() { return false } }
    const detail = (await decideCellHost(probe)).detail

    expect(detail).toContain('但连不上')
    expect(detail).toContain('容器 → 宿主')
    expect(detail).toContain('宿主防火墙')
    expect(detail).toContain('不会**拿一个连不上的地址继续起会话')
  })

  it('两种失败混在一起时，说的是「两种都有，先各查各的」', async () => {
    const probe: CellHostProbe = {
      async resolve(host) {
        return host === 'host.docker.internal' ? null : host
      },
      async reachable() {
        return false
      },
    }
    const detail = (await decideCellHost(probe)).detail

    expect(detail).toContain('有的是名字不存在、有的是名字对但连不上')
  })

  it('每条候选的失败原因都在里面——用户要能一条条对着看', async () => {
    const probe: CellHostProbe = {
      async resolve(host) {
        return host === '192.168.65.2' ? null : host
      },
      async reachable() {
        return false
      },
    }
    const detail = (await decideCellHost(probe)).detail

    expect(detail).toContain('192.168.65.2：舱内解析不出这个名字')
    expect(detail).toContain('172.17.0.1：解析为 172.17.0.1，但连不上')
    // 出口永远留着：可以改成不探测。
    expect(detail).toContain('broker.cellHost')
    expect(detail).toContain('--cell-host')
  })
})

describe('--add-host 什么时候才加', () => {
  it('名字解析不出来才加——这是 docker-verification §2.1 实测出来的规则', () => {
    expect(needsHostGatewayMapping(null)).toBe(true)
    expect(needsHostGatewayMapping('192.168.65.2')).toBe(false)
    // 解析成什么都算「存在」：判断的是有无，不是地址好不好。
    expect(needsHostGatewayMapping('fdc4:f303:9324::254')).toBe(false)
  })

  it('映射值是 docker 自己认的字面量，不是我们算出来的网关', () => {
    expect(HOST_GATEWAY_MAPPING).toBe('host-gateway')
  })
})

describe('bindHostCandidates · 绑哪是另一件事', () => {
  it('local 后端：回环，只有一个候选', () => {
    expect(bindHostCandidates({ backend: 'local', configuredHost: '172.17.0.1' })).toEqual(['127.0.0.1'])
  })

  it('docker 后端：先试配置里那个（在 linux 上是最窄的），不行才退到 0.0.0.0', () => {
    // 顺序不能反：反了就把舱面在 linux 上摊到所有网卡，而那里本来有个更窄的可用。
    expect(bindHostCandidates({ backend: 'docker', configuredHost: '172.17.0.1' })).toEqual(['172.17.0.1', '0.0.0.0'])
  })

  it('配置里本来就是 0.0.0.0 时不重复', () => {
    expect(bindHostCandidates({ backend: 'docker', configuredHost: '0.0.0.0' })).toEqual(['0.0.0.0'])
  })

  it('配置里是**名字**时不拿它 bind —— 那是舱内的名字，宿主上绑不了', () => {
    // 这是新默认值 `host.docker.internal` 走的那条路。它在容器里解析得到宿主 VM，
    // 在宿主上要么解析不出来、要么指到别的地方，`listen()` 的结果不是我们能预期的。
    // 直接退到 0.0.0.0 —— Docker Desktop 上实测可用。
    expect(bindHostCandidates({ backend: 'docker', configuredHost: 'host.docker.internal' })).toEqual(['0.0.0.0'])
  })

  it('IPv6 字面量也算字面量', () => {
    expect(bindHostCandidates({ backend: 'docker', configuredHost: '::1' })).toEqual(['::1', '0.0.0.0'])
  })

  it('显式给了地址就只绑它——用户写死了就不再退让，否则配置是骗人的', () => {
    expect(bindHostCandidates({ backend: 'docker', configuredHost: '172.17.0.1', override: '10.1.2.3' })).toEqual(['10.1.2.3'])
    // local 后端也一样：显式值优先于「local 就用回环」。
    expect(bindHostCandidates({ backend: 'local', configuredHost: '172.17.0.1', override: '10.1.2.3' })).toEqual(['10.1.2.3'])
  })

  it('空字符串当成没给', () => {
    expect(bindHostCandidates({ backend: 'local', configuredHost: '172.17.0.1', override: '' })).toEqual(['127.0.0.1'])
  })
})
