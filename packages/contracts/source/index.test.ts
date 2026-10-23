import { describe, expect, it } from 'vitest'
import { productName } from './index'

describe('contracts', () => {
  it('exposes the product name', () => {
    expect(productName).toBe('abx')
  })
})
