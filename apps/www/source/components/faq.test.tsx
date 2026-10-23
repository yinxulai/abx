// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * FAQ 的判据是**每一问都答在机制上**，而不是「都填了字」。
 *
 * 重点盯两处最容易写成气氛组的地方：密钥为什么不会进舱（要答「怎么拦的」，
 * 不是「请放心」），以及白名单不够用怎么办（要答「你能看到被拦的是哪个域名」，
 * 不是「按需配置即可」）。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /八件事|Eight things/ })

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('FAQ', { timeout: FULL_PAGE_TIMEOUT }, () => {
  it('answers the questions a reader has before deciding', async () => {
    await renderApp('zh')

    const questions = within(section()).getAllByRole('term')
    expect(questions.map(textOf)).toEqual([
      '这跟直接在本机跑 agent 有什么区别？',
      '密钥真的不会进舱吗？',
      '这算沙箱吗？和虚拟机比呢？',
      '为什么只支持 macOS？',
      '需要改我现在的 OSW 配置吗？',
      '白名单不够用怎么办？',
      '现在能下载了吗？',
      '有账号吗？会上报数据吗？另外收费吗？',
    ])
    expect(within(section()).getAllByRole('definition')).toHaveLength(questions.length)
  })

  it('answers with the mechanism, not with reassurance', async () => {
    await renderApp('zh')

    const body = textOf(section())
    // 密钥那一问要说出「占位符 + 转发时注入 + 有测试」，不是「请放心」。
    expect(body).toContain('占位符')
    expect(body).toContain('转发那一刻才注入')
    expect(body).toContain('有测试守着')
    // 白名单那一问要说到「被拦的域名能看见」。
    expect(body).toContain('被拦的域名')
    expect(body).toContain('还没有图形界面')
  })

  it('does not promise availability it does not have', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('还不能')
    expect(body).toContain('没有可发布的安装包')
    // 首页任何位置都不该出现一个点不动的下载链接。
    expect(within(section()).queryAllByRole('link')).toEqual([])
  })
})
