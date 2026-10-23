/**
 * 来源网段判定的单测。
 *
 * 这一层是纯函数，所以「网段外拒绝」这件事能在这里用真实地址逐条钉死，
 * 不用去凑一个真的从别的网段打过来的连接（那件事只有 docker 里验得了）。
 * `broker.e2e.test.ts` 里再验一遍「接进 HTTP 之后确实是 403」。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWED_CELL_SUBNETS,
  LOOPBACK_SUBNET,
  classifyCellSource,
  findInvalidCellSubnets,
  isAllowedCellSource,
  isLoopbackAddress,
  normalizeRemoteAddress,
} from './cell-source'

/** 需求里给的 docker 网段：宿主网桥 + VM 网关。 */
const DOCKER_SUBNETS = ['192.168.65.0/24', '172.17.0.0/16']

describe('isAllowedCellSource', () => {
  it('网段内的来源放行', () => {
    expect(isAllowedCellSource('192.168.65.2', DOCKER_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('172.17.0.2', DOCKER_SUBNETS)).toBe(true)
  })

  it('网段外的来源拒绝', () => {
    // 宿主回环：实测里它打舱面是 200，这道闸就是为它装的。
    expect(isAllowedCellSource('127.0.0.1', DOCKER_SUBNETS)).toBe(false)
    // 局域网里另一台机器。
    expect(isAllowedCellSource('10.0.0.7', DOCKER_SUBNETS)).toBe(false)
    expect(isAllowedCellSource('192.168.1.5', DOCKER_SUBNETS)).toBe(false)
    // 公网地址。
    expect(isAllowedCellSource('8.8.8.8', DOCKER_SUBNETS)).toBe(false)
  })

  it('网段边界：/24 的头和尾都在里面，隔壁网段不在', () => {
    expect(isAllowedCellSource('192.168.65.0', DOCKER_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('192.168.65.255', DOCKER_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('192.168.64.255', DOCKER_SUBNETS)).toBe(false)
    expect(isAllowedCellSource('192.168.66.1', DOCKER_SUBNETS)).toBe(false)
  })

  it('网段边界：/16 跨两个八位组', () => {
    expect(isAllowedCellSource('172.17.0.0', DOCKER_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('172.17.255.255', DOCKER_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('172.16.255.255', DOCKER_SUBNETS)).toBe(false)
    expect(isAllowedCellSource('172.18.0.0', DOCKER_SUBNETS)).toBe(false)
  })

  it('/0 覆盖整个 IPv4 空间', () => {
    expect(isAllowedCellSource('8.8.8.8', ['0.0.0.0/0'])).toBe(true)
    expect(isAllowedCellSource('255.255.255.255', ['0.0.0.0/0'])).toBe(true)
  })

  it('裸地址按 /32 处理，只放行它自己', () => {
    expect(isAllowedCellSource('192.168.65.2', ['192.168.65.2'])).toBe(true)
    expect(isAllowedCellSource('192.168.65.3', ['192.168.65.2'])).toBe(false)
  })

  it('网络号带了主机位时按标准做法对齐', () => {
    // 192.168.65.7/24 与 192.168.65.0/24 是同一个网段。
    expect(isAllowedCellSource('192.168.65.2', ['192.168.65.7/24'])).toBe(true)
    expect(isAllowedCellSource('192.168.66.2', ['192.168.65.7/24'])).toBe(false)
  })

  it('拿不到来源地址就拒绝', () => {
    expect(isAllowedCellSource(undefined, DOCKER_SUBNETS)).toBe(false)
    expect(isAllowedCellSource('', DOCKER_SUBNETS)).toBe(false)
    expect(isAllowedCellSource('   ', DOCKER_SUBNETS)).toBe(false)
  })

  // 「没配」和「配了但不匹配」都是拒绝，但必须分得开：前者是配置漏了，
  // 后者是真的有人在打。审计里要能一眼看出来是哪一种。
  it('空列表 = 全部拒绝，且拒因是「没配」而不是「不匹配」', () => {
    expect(isAllowedCellSource('192.168.65.2', [])).toBe(false)
    expect(classifyCellSource('192.168.65.2', []).reason).toBe('no-subnets')

    expect(classifyCellSource('127.0.0.1', DOCKER_SUBNETS).reason).toBe('outside-subnets')
    expect(classifyCellSource(undefined, DOCKER_SUBNETS).reason).toBe('no-address')
  })

  it('全是畸形条目时也算「没配」——一条都没生效', () => {
    const broken = ['192.168.65.0/33', 'hello', '', '192.168.65.0/24/8']
    expect(isAllowedCellSource('192.168.65.2', broken)).toBe(false)
    expect(classifyCellSource('192.168.65.2', broken).reason).toBe('no-subnets')
  })

  it('畸形条目被跳过，好的那些照样生效（不抛异常）', () => {
    const mixed = ['nonsense', '192.168.65.0/24']
    expect(isAllowedCellSource('192.168.65.2', mixed)).toBe(true)
    expect(isAllowedCellSource('172.17.0.2', mixed)).toBe(false)
  })

  it('真 IPv6 来源判成「判不了」，不是悄悄放过', () => {
    expect(classifyCellSource('fe80::1', DOCKER_SUBNETS)).toMatchObject({
      allowed: false,
      reason: 'unsupported-address',
    })
    // 回环的 IPv6 也一样：它不在任何 IPv4 网段里。
    expect(classifyCellSource('::1', DOCKER_SUBNETS).allowed).toBe(false)
  })

  it('非法地址字符串拒绝', () => {
    for (const address of ['999.1.1.1', '192.168.65', '192.168.65.2.5', 'abc', '192.168.65.-1']) {
      expect(isAllowedCellSource(address, DOCKER_SUBNETS)).toBe(false)
    }
  })

  it('判定结果带上归一化之后的来源地址（审计要用）', () => {
    expect(classifyCellSource('::ffff:192.168.65.2', DOCKER_SUBNETS)).toEqual({
      allowed: true,
      reason: 'allowed',
      address: '192.168.65.2',
    })
    expect(classifyCellSource(undefined, DOCKER_SUBNETS).address).toBeNull()
  })

  it('默认网段是 docker 那两条 + 回环', () => {
    expect(DEFAULT_ALLOWED_CELL_SUBNETS).toEqual([...DOCKER_SUBNETS, LOOPBACK_SUBNET])
    expect(isAllowedCellSource('192.168.65.2', DEFAULT_ALLOWED_CELL_SUBNETS)).toBe(true)
    expect(isAllowedCellSource('172.17.0.2', DEFAULT_ALLOWED_CELL_SUBNETS)).toBe(true)
    // 回环必须在里面：Docker Desktop 上容器打宿主就是落在回环上的（见 cell-source.ts
    // 里那段实测），少了它舱一个请求都进不来。这不是「放水」——见下面那条。
    expect(isAllowedCellSource('127.0.0.1', DEFAULT_ALLOWED_CELL_SUBNETS)).toBe(true)
  })

  it('默认网段挡的是局域网，不是本机', () => {
    // 这条闸真正挡住的是「网桥外面的人」：局域网里另一台机器走的是普通内核路径，
    // 来源地址是它自己的地址，落不进默认列表。
    for (const outsider of ['192.168.1.7', '10.0.0.9', '203.0.113.5', '172.18.0.2']) {
      expect(isAllowedCellSource(outsider, DEFAULT_ALLOWED_CELL_SUBNETS)).toBe(false)
    }
  })
})

describe('normalizeRemoteAddress', () => {
  it('IPv4-mapped IPv6 还原成 IPv4', () => {
    expect(normalizeRemoteAddress('::ffff:192.168.65.2')).toBe('192.168.65.2')
    // 大小写不该影响判定：内核报的是哪一种写法不由我们决定。
    expect(normalizeRemoteAddress('::FFFF:192.168.65.2')).toBe('192.168.65.2')
    // 同一个来源的两种写法必须落在同一个判定结果上。
    expect(isAllowedCellSource('::ffff:192.168.65.2', DOCKER_SUBNETS)).toBe(
      isAllowedCellSource('192.168.65.2', DOCKER_SUBNETS),
    )
  })

  it('mapped 之后网段外的还是网段外', () => {
    expect(isAllowedCellSource('::ffff:127.0.0.1', DOCKER_SUBNETS)).toBe(false)
  })

  it('IPv4 规范化', () => {
    expect(normalizeRemoteAddress(' 192.168.65.2 ')).toBe('192.168.65.2')
    // 前导零写法在别的实现里可能是八进制（`065` = 53），含义不唯一，所以不解析。
    // 结果是「不匹配」：判不出来的时候拒绝。
    expect(isAllowedCellSource('192.168.065.2', DOCKER_SUBNETS)).toBe(false)
  })

  it('普通 IPv6 原样留下（小写、剥掉 scope）', () => {
    expect(normalizeRemoteAddress('FE80::1')).toBe('fe80::1')
    expect(normalizeRemoteAddress('fe80::1%eth0')).toBe('fe80::1')
  })

  it('空值返回 null', () => {
    expect(normalizeRemoteAddress(undefined)).toBeNull()
    expect(normalizeRemoteAddress('')).toBeNull()
    expect(normalizeRemoteAddress('  ')).toBeNull()
  })
})

describe('isLoopbackAddress', () => {
  it('认整个 127.0.0.0/8，也认 IPv6 的回环', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
  })

  it('不是回环的返回 false', () => {
    expect(isLoopbackAddress('192.168.65.2')).toBe(false)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('fe80::1')).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })
})

describe('findInvalidCellSubnets', () => {
  it('只挑出写错的条目', () => {
    expect(findInvalidCellSubnets(['192.168.65.0/24', 'oops', '1.2.3.4/33', '10.0.0.0/8'])).toEqual([
      'oops',
      '1.2.3.4/33',
    ])
  })

  it('全是好的就没有输出', () => {
    expect(findInvalidCellSubnets(DOCKER_SUBNETS)).toEqual([])
    expect(findInvalidCellSubnets([])).toEqual([])
  })
})
