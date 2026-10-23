/**
 * 舱令牌注册表：令牌 → 舱 id。
 *
 * 它是「单实例多舱」的落点。一个 broker 进程服务全部舱，每个舱拿自己的令牌；
 * 令牌是**唯一**的身份来源——舱 id 从这里反查得出，不看请求头，因此不可伪造。
 *
 * 为什么不用「一个令牌给所有舱」：
 *   - 那个令牌在任一舱泄漏，等于整个宿主泄漏；
 *   - 审计只能记一个笼统的身份，分不清是哪个会话。
 *
 * 只是内存里的两张表，进程退出即失。令牌本身仍有生命周期：起舱时注册，
 * 舱销毁时注销，注销之后原令牌立刻失效。注册表还有数量上限——泄漏的令牌不该
 * 无限堆在内存里，到上限时拒绝起新舱，并把「当前多少、上限多少」说清楚。
 *
 * 这个类不碰 HTTP。`server.ts` 只拿它做两件事：查令牌、登记/注销舱。
 */

import { generateCellToken } from './token'

/** 默认最多同时登记多少个舱。宿主固定令牌的「默认舱」也占一个位置。 */
export const DEFAULT_CELL_REGISTRY_LIMIT = 64

/** 注册表自身的失败：满了、令牌冲突、舱 id 不合法。都是调用方可以处理的错误。 */
export class CellRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CellRegistryError'
  }
}

export interface CellRegistryOptions {
  /** 同时登记的舱数量上限（含默认舱）。默认 {@link DEFAULT_CELL_REGISTRY_LIMIT}。 */
  readonly limit?: number
}

export class CellTokenRegistry {
  readonly #limit: number
  /** 舱 id → 令牌。注销时按舱 id 找令牌，所以两个方向都要存。 */
  readonly #tokenByCell = new Map<string, string>()
  /** 令牌 → 舱 id。请求鉴权只查这一张。 */
  readonly #cellByToken = new Map<string, string>()

  constructor(options: CellRegistryOptions = {}) {
    const limit = options.limit ?? DEFAULT_CELL_REGISTRY_LIMIT
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`舱令牌注册表的上限必须是正整数，实际是 ${limit}`)
    }
    this.#limit = limit
  }

  get limit(): number {
    return this.#limit
  }

  get size(): number {
    return this.#tokenByCell.size
  }

  /**
   * 给一个舱生成并登记新令牌。
   *
   * 同一个舱重复注册时，旧令牌会先作废——一个舱在同一时刻只该有一条有效令牌，
   * 否则「注销 / 重新起舱」会把旧值留在表里，泄漏面反而变大。
   */
  register(cellId: string): string {
    const id = normalizeCellId(cellId)
    this.#forget(id)
    this.#assertCapacity()

    let token = generateCellToken()
    // 32 字节随机值撞上的概率可以忽略，但既然能一行处理掉，就别把「理论上可能」
    // 留成一张写着重号的地图。
    while (this.#cellByToken.has(token)) token = generateCellToken()

    this.#tokenByCell.set(id, token)
    this.#cellByToken.set(token, id)
    return token
  }

  /**
   * 登记一个**已知**令牌。
   *
   * 给「宿主固定令牌」留的口子：环境变量 / `--token` 指定的值要先在 CLI 与 broker
   * 之间共享，不能由 broker 现生成。它只对应一个默认舱，开发与自测用。
   */
  registerFixed(cellId: string, token: string): void {
    const id = normalizeCellId(cellId)
    const value = token.trim()
    if (value === '') throw new CellRegistryError('舱令牌不能是空字符串')

    const owner = this.#cellByToken.get(value)
    if (owner !== undefined && owner !== id) {
      throw new CellRegistryError(`这个令牌已经绑定给舱 ${owner}，不能再绑定给 ${id}`)
    }

    this.#forget(id)
    this.#assertCapacity()
    this.#tokenByCell.set(id, value)
    this.#cellByToken.set(value, id)
  }

  /** 反查令牌对应的舱 id。未知令牌返回 `null`。 */
  resolve(token: string): string | null {
    return this.#cellByToken.get(token) ?? null
  }

  /** 注销一个舱。返回是否真的删掉了一条；重复注销是安全的。 */
  unregister(cellId: string): boolean {
    return this.#forget(cellId.trim())
  }

  #assertCapacity(): void {
    if (this.#tokenByCell.size < this.#limit) return
    throw new CellRegistryError(
      `舱令牌注册表已满：当前 ${this.#tokenByCell.size} 个舱，上限 ${this.#limit} 个舱。` +
        `先注销已经销毁的舱，或者调大上限（cellRegistryLimit）。`,
    )
  }

  #forget(cellId: string): boolean {
    const token = this.#tokenByCell.get(cellId)
    if (token === undefined) return false
    this.#tokenByCell.delete(cellId)
    this.#cellByToken.delete(token)
    return true
  }
}

function normalizeCellId(cellId: string): string {
  const value = cellId.trim()
  if (value === '') throw new CellRegistryError('舱 id 不能是空字符串')
  return value
}
