// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp, textOf } from '../test-support'

/**
 * 托盘面板是**示意图**，不是产品截图。这一块最容易出的两种错：
 * 把它画得像是已经能用的产品（缺「示意」标注），以及让读屏去念一堆装饰文字。
 */
afterEach(cleanup)

const figure = () => screen.getByRole('figure')

describe('tray panel mock-up', () => {
  it('is hidden from assistive technology, with the caption carrying the meaning', async () => {
    await renderApp('zh')

    const mock = figure().querySelector('[aria-hidden="true"]')
    expect(mock).not.toBeNull()
    expect(textOf(figure().querySelector('figcaption'))).toContain('示意')
  })

  it('describes the panel in the language of the page', async () => {
    await renderApp('zh')
    expect(textOf(figure())).toContain('共享给全部 agent')
    expect(textOf(figure())).toContain('只读')

    cleanup()
    await renderApp('en')
    expect(textOf(figure())).toContain('Shared with every agent')
    expect(textOf(figure())).toContain('read-only')
  })

  it('uses the short agent names the panel itself uses', async () => {
    await renderApp('zh')

    // 面板上是短名（Claude / Codex / dsh），清单里的全名属于「agent 一览」那一节。
    const body = textOf(figure())
    expect(body).toContain('Claude')
    expect(body).toContain('Codex')
    expect(body).toContain('dsh')
    expect(body).not.toContain('Claude Code')
  })
})
