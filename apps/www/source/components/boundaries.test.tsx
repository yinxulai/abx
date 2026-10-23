// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 这一节的判据不是「有没有写限制」，而是**限制和承诺在同一屏上**：
 *
 * - 四条边界必须在；
 * - 不承诺项必须包含那几条最容易被人自行外推掉的（内核逃逸、你自己递凭据、
 *   网络匿名、还没做过对抗测试）；
 * - 平台矩阵必须把 macOS 的「还没在真机验过」和 Linux 的「不是沙箱」说出来；
 * - 「什么情况下不适用」必须有内容 —— 只讲能用的场景，等于没有边界。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /默认安全|Safe by default/ })

describe('boundaries', () => {
  it('states the four defaults that are not settings', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('默认拒绝出口')
    expect(body).toContain('共享区只读')
    expect(body).toContain('审计留痕')
    expect(body).toContain('一次性的舱')
  })

  it('names what it does not promise, including the ones readers extrapolate away', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('明确不承诺什么')
    expect(body).toContain('不承诺防住内核级逃逸')
    expect(body).toContain('不承诺防住你主动把凭据拖进共享区')
    expect(body).toContain('不承诺网络侧匿名')
    expect(body).toContain('不承诺已经扛住对抗性攻击')
    expect(body).toContain('不承诺任务目录里的改动可回滚')
  })

  it('gives every platform an honest support level', async () => {
    await renderApp('zh')

    const table = within(section()).getByRole('table')
    const rows = within(table).getAllByRole('row')
    // 表头 + 三个平台。
    expect(rows).toHaveLength(4)

    const body = textOf(table)
    expect(body).toContain('macOS')
    expect(body).toContain('V1 目标平台')
    expect(body).toContain('尚未在 macOS 真机上验证')
    expect(body).toContain('Linux')
    // local 后端不是沙箱，这句必须原样出现，不能只写「开发期」。
    expect(body).toContain('不是沙箱，禁止用于演示')
    expect(body).toContain('Windows')
    expect(body).toContain('不做')
  })

  it('says when the product does not apply at all', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('什么情况下不适用')
    expect(body).toContain('舱里没有图形界面')
    expect(body).toContain('该用虚拟机')
    expect(body).toContain('舱里没有 docker socket')
    expect(body).toContain('舱是一次性的')
  })

  it('draws every icon with lucide, not with hand-written paths', async () => {
    await renderApp('zh')

    // lucide 渲染出来的 svg 都带 `lucide` 类名；手绘的没有。品牌标（airlock-mark）
    // 不在这一节里，它是 logo，不是图标。
    const icons = section().querySelectorAll('svg')
    expect(icons.length).toBeGreaterThan(0)
    expect([...icons].filter(icon => !icon.classList.contains('lucide'))).toEqual([])
  })
})
