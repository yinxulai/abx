// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/*
 * 官网顶栏那个标志的**防漂移**对账。
 *
 * 这条线以前在站点上画的是**另一张图形**：一扇线描的舱门（`airlock-mark.tsx`），
 * 与产品里那个 Bot 的头没有关系。同一个品牌在自家官网上有第二份画稿，
 * 比没有标志更糟——它看起来是对的。
 *
 * 比的是 `apps/www/public/icon.svg`，也就是**站点自己发的那个文件**：
 * 它由 `pnpm icons` 从 `packages/console/public/icon.svg` 派生，
 * 与真源逐字节相同（那一层由 `packages/console/source/brand-assets.test.ts` 守着）。
 * 于是这一条把「页头画的东西」与「favicon 里的东西」绑在一起：改了一处而没改另一处就红。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../public/icon.svg'), 'utf8')

/** 真源里那三段渐变的 stop。 */
const stopsOf = (svg: string): readonly (readonly [string, string])[] =>
  [...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ] as const)

/** 蒙版里那两只洞（眼睛是**挖**出来的，不是画上去的白点）。 */
const eyesOf = (svg: string): readonly (readonly [string, string, string])[] =>
  [...svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)" fill="#000"\/>/g)].map(
    (match) => [match[1] ?? '', match[2] ?? '', match[3] ?? ''] as const,
  )

afterEach(cleanup)

describe('brand mark', { timeout: FULL_PAGE_TIMEOUT }, () => {
  /** 顶栏左边那个回页首的品牌链接，标志就在它里面。 */
  const brandLink = (container: HTMLElement): HTMLElement => {
    const link = container.querySelector('header a[href="#main"]')
    if (link === null) throw new Error('顶栏里没有找到品牌链接：`header a[href="#main"]`')
    return link as HTMLElement
  }

  const markOf = (container: HTMLElement): SVGElement => {
    const mark = brandLink(container).querySelector('svg')
    if (mark === null) throw new Error('品牌链接里没有标志')
    return mark as SVGElement
  }

  it('对账本身不能空转：真源读到了东西，顶栏里也真有一个 svg', async () => {
    const { container } = await renderApp('zh')

    expect(source).toContain('viewBox="0 0 256 256"')
    expect(stopsOf(source)).toHaveLength(3)
    expect(eyesOf(source)).toHaveLength(2)
    expect(markOf(container).tagName.toLowerCase()).toBe('svg')
  })

  it('viewBox 与三段渐变的 stop 和站点 favicon 逐字相符', async () => {
    const { container } = await renderApp('zh')
    const mark = markOf(container)

    const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1]
    expect(viewBox).toBe('0 0 256 256')
    expect(mark.getAttribute('viewBox')).toBe(viewBox)

    const rendered = [...mark.querySelectorAll('stop')].map(
      stop => [stop.getAttribute('offset') ?? '', stop.getAttribute('stop-color') ?? ''] as const,
    )
    expect(rendered).toEqual(stopsOf(source))
    // 末端的紫是**故意去掉**的（`assets/brand/README.md`）：两端对齐之后，
    // 两个产品的图标摆在一起是同一套色。
    expect(rendered.map(([, color]) => color)).not.toContain('#7C3AED')
  })

  it('头那一笔与眼睛里那两只洞，同样与 favicon 逐字相符', async () => {
    const { container } = await renderApp('zh')
    const mark = markOf(container)

    const rect = mark.querySelector('rect[x="16"]')
    expect(rect === null).toBe(false)
    expect(['x', 'y', 'width', 'height', 'rx'].map(name => rect?.getAttribute(name))).toEqual([
      '16',
      '34',
      '224',
      '188',
      '62',
    ])
    expect(rect?.getAttribute('fill')).toBe('url(#abx-mark)')
    expect(rect?.getAttribute('mask')).toBe('url(#abx-eyes)')

    const eyes = [...mark.querySelectorAll('mask circle')].map(circle =>
      ['cx', 'cy', 'r'].map(name => circle.getAttribute(name)),
    )
    expect(eyes).toEqual(eyesOf(source).map(eye => [...eye]))
  })

  it('标志是装饰：aria-hidden，名字由挨着它的那两个字承担', async () => {
    const { container } = await renderApp('zh')
    const mark = markOf(container)
    const link = brandLink(container)

    expect(mark.getAttribute('aria-hidden')).toBe('true')
    // 标志自己不带名字：带了读屏就会把同一件事念两遍。
    expect(mark.getAttribute('aria-label')).toBeNull()
    expect(mark.getAttribute('role')).toBeNull()
    // 名字在旁边，是**文字**：图标永不单独承载语义（`design-system.md` §2、§5）。
    expect(textOf(link)).toContain('abx')
    expect(within(link).getByText('abx')).not.toBeNull()
  })
})
