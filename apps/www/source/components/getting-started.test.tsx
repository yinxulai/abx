// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 「开始使用」的判据是**它没有撒谎**：
 *
 * - 三步就是三步（多一步就说明这一节在往手册长）；
 * - 第一步必须写着现在还没有安装包 —— 这一节最容易退化成一句假的「点这里下载」；
 * - 拖一个目录进去之后会发生什么必须写出来（只读、取回区），
 *   而不是「享受无缝体验」这种读完还是不知道会发生什么的话。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /三步|Three steps/ })

describe('getting started', () => {
  it('stays at three steps', async () => {
    await renderApp('zh')

    const steps = within(section()).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps.map(step => textOf(within(step).getByRole('heading', { level: 3 })))).toEqual([
      '装好它',
      '第一次打开',
      '拖一个目录进去',
    ])
  })

  it('says there is nothing to download yet instead of pointing at a link', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('安装包还没发布')
    expect(body).toContain('ad-hoc')
    // 没有安装包就不放链接 —— 一个点不动的下载按钮比没有按钮更糟。
    expect(within(section()).queryAllByRole('link')).toEqual([])
  })

  it('describes what happens when a directory is dropped in', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('共享条目')
    expect(body).toContain('只读')
    expect(body).toContain('取回区')
    // 「停止全部」到底停了什么、什么会留下 —— 这句是这一节里最容易被误解的地方。
    expect(body).toContain('「停止全部」停的是舱')
    expect(body).toContain('不删你的原文件')
  })
})
