import { describe, expect, it } from 'vitest'
import { CellRegistryError, CellTokenRegistry, DEFAULT_CELL_REGISTRY_LIMIT } from './registry'

describe('CellTokenRegistry', () => {
  it('注册后能反查，未知令牌返回 null', () => {
    const registry = new CellTokenRegistry()
    const token = registry.register('cell-a')

    expect(token.length).toBeGreaterThan(0)
    expect(registry.resolve(token)).toBe('cell-a')
    expect(registry.resolve('not-a-registered-token')).toBeNull()
    expect(registry.size).toBe(1)
  })

  it('两个舱拿到不同的令牌，互不串门', () => {
    const registry = new CellTokenRegistry()
    const tokenA = registry.register('cell-a')
    const tokenB = registry.register('cell-b')

    expect(tokenA).not.toBe(tokenB)
    expect(registry.resolve(tokenA)).toBe('cell-a')
    expect(registry.resolve(tokenB)).toBe('cell-b')
  })

  it('注销之后原令牌立刻失效', () => {
    const registry = new CellTokenRegistry()
    const token = registry.register('cell-a')

    expect(registry.unregister('cell-a')).toBe(true)
    expect(registry.resolve(token)).toBeNull()
    expect(registry.size).toBe(0)
    // 重复注销是安全的，只是没东西可删。
    expect(registry.unregister('cell-a')).toBe(false)
  })

  it('同一个舱重新注册会让旧令牌失效', () => {
    const registry = new CellTokenRegistry()
    const first = registry.register('cell-a')
    const second = registry.register('cell-a')

    expect(second).not.toBe(first)
    expect(registry.resolve(first)).toBeNull()
    expect(registry.resolve(second)).toBe('cell-a')
    expect(registry.size).toBe(1)
  })

  it('达到上限后注册失败，错误里同时说明当前数量与上限', () => {
    const registry = new CellTokenRegistry({ limit: 2 })
    registry.register('cell-a')
    registry.register('cell-b')

    expect(() => registry.register('cell-c')).toThrow(CellRegistryError)
    expect(() => registry.register('cell-c')).toThrow(/当前 2 个舱/)
    expect(() => registry.register('cell-c')).toThrow(/上限 2 个舱/)
    expect(registry.size).toBe(2)
  })

  it('满员时重新注册已有的舱仍然可以（总数不变）', () => {
    const registry = new CellTokenRegistry({ limit: 1 })
    const first = registry.register('cell-a')

    const second = registry.register('cell-a')
    expect(registry.resolve(first)).toBeNull()
    expect(registry.resolve(second)).toBe('cell-a')
  })

  it('默认上限是 64', () => {
    expect(new CellTokenRegistry().limit).toBe(DEFAULT_CELL_REGISTRY_LIMIT)
    expect(DEFAULT_CELL_REGISTRY_LIMIT).toBe(64)
  })

  it('上限必须是正整数', () => {
    expect(() => new CellTokenRegistry({ limit: 0 })).toThrow(RangeError)
    expect(() => new CellTokenRegistry({ limit: -1 })).toThrow(RangeError)
    expect(() => new CellTokenRegistry({ limit: 1.5 })).toThrow(RangeError)
  })

  it('空的舱 id 会被拒绝', () => {
    const registry = new CellTokenRegistry()
    expect(() => registry.register('   ')).toThrow(CellRegistryError)
    expect(() => registry.registerFixed('', 'token')).toThrow(CellRegistryError)
  })

  it('固定令牌能登记并反查', () => {
    const registry = new CellTokenRegistry()
    registry.registerFixed('default', 'host-token')

    expect(registry.resolve('host-token')).toBe('default')
    expect(registry.size).toBe(1)
  })

  it('同一个令牌不能绑定给两个舱', () => {
    const registry = new CellTokenRegistry()
    registry.registerFixed('cell-a', 'shared-token')

    expect(() => registry.registerFixed('cell-b', 'shared-token')).toThrow(CellRegistryError)
    expect(registry.resolve('shared-token')).toBe('cell-a')
  })

  it('固定令牌为空时拒绝登记', () => {
    const registry = new CellTokenRegistry()
    expect(() => registry.registerFixed('default', '   ')).toThrow(CellRegistryError)
  })

  it('固定令牌也占上限', () => {
    const registry = new CellTokenRegistry({ limit: 1 })
    registry.registerFixed('default', 'host-token')

    expect(() => registry.register('cell-a')).toThrow(/当前 1 个舱/)
  })
})
