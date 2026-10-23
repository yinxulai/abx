// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 下载区的判据只有一条，但它比看上去重要：**没有东西可下载时，一个链接都不许有**。
 * 一个点了没反应的下载按钮会让人怀疑整页的其它话。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /macOS 版|macOS, in progress/ })

describe('download section', () => {
  it('says the installer does not exist yet', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('尚未提供')
    expect(body).toContain('还没有可供下载的安装包')
  })

  it('offers nothing clickable while there is nothing to download', async () => {
    await renderApp('zh')

    expect(within(section()).queryAllByRole('link')).toEqual([])
    expect(within(section()).queryAllByRole('button')).toEqual([])
  })

  it('promises no date and points at the changelog for the real answer', async () => {
    await renderApp('zh')

    const body = textOf(section())
    expect(body).toContain('不提前承诺一个日期')
    expect(body).toContain('更新日志')
  })

  it('reads as English when the page is in English', async () => {
    await renderApp('en')

    const body = textOf(section())
    expect(body).toContain('Not available yet')
    expect(body).toContain('macOS, in progress')
  })
})
