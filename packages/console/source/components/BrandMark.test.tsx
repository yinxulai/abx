// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'

/*
 * 标志的**防漂移**对账：标题栏里渲染出来的那一份，与唯一矢量源逐条对齐。
 *
 * 防的是「有人另画了一份近似的标志」——那是这个仓库里最坏的一种漂移：
 * 一份相似的东西比一份缺失的更糟，因为它看起来是对的，而界面上于是有两个品牌。
 * `packages/console/source/components/BrandMark.tsx` 为了排版内联了一份几何，
 * 这条测试就是那份几何的代价：真源改一处，这里不改就红。
 *
 * 比的是**渲染出来的 DOM**，不是组件源码文本——源码里 `stopColor` 与 `stop-color`
 * 写法不同，正则对源码只会对出「像」，对不出「一样」。
 * 站点那两个 head 的 favicon 引用由 `brand-assets.test.ts` 守（那份是产物对账）。
 */

/**
 * 唯一矢量源。所有位图与站点副本都由 `pnpm icons` 从它派生。
 *
 * 路径从 `import.meta.url` 推，不写 `process.cwd()`：文件位置与「谁在读它」是两件事，
 * 而这份测试要能在任何工作目录下找到真源。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../public/icon.svg'), 'utf8')

/** 真源里那三段渐变的 stop。 */
function stopsOf(svg: string): readonly (readonly [string, string])[] {
  return [...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ] as const)
}

/** 真源里的蒙版：一条白底 + 两只黑圆（眼睛是**挖**出来的，不是画上去的白点）。 */
function eyesOf(svg: string): readonly (readonly [string, string, string])[] {
  return [...svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)" fill="#000"\/>/g)].map(
    (match) => [match[1] ?? '', match[2] ?? '', match[3] ?? ''] as const,
  )
}

/** jsdom 没有 ResizeObserver；面板里用它量高，给个静默替身。 */
class NoopResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
})

afterEach(cleanup)

describe('标题栏里的标志与真源逐条一致', () => {
  const renderMark = () => {
    const { container } = render(<App />)
    const mark = container.querySelector('.abx-header svg')
    if (mark === null) throw new Error('标题栏里没有找到标志：`.abx-header svg`')
    return { container, mark, header: container.querySelector('.abx-header') }
  }

  it('对账本身不能空转：真源读到了东西，标题栏里也真有一个 svg', () => {
    expect(source).toContain('viewBox="0 0 256 256"')
    expect(stopsOf(source)).toHaveLength(3)
    expect(eyesOf(source)).toHaveLength(2)
    expect(renderMark().mark.tagName.toLowerCase()).toBe('svg')
  })

  it('viewBox 与真源逐字相符', () => {
    const { mark } = renderMark()
    const documented = /viewBox="([^"]+)"/.exec(source)?.[1]
    expect(documented).toBe('0 0 256 256')
    expect(mark.getAttribute('viewBox')).toBe(documented)
  })

  it('三段渐变的 stop 与真源逐字相符，且没有第四段', () => {
    const { mark } = renderMark()
    const rendered = [...mark.querySelectorAll('stop')].map(
      (stop) => [stop.getAttribute('offset') ?? '', stop.getAttribute('stop-color') ?? ''] as const,
    )
    expect(rendered).toEqual(stopsOf(source))
    // 末端的紫是**故意去掉**的（`assets/brand/README.md`）：紫色铺在 abx 这种大色块上
    // 是右下角一块脏，而且两端对齐意味着两个产品的图标摆在一起是同一套色。
    expect(rendered.map(([, color]) => color)).not.toContain('#7C3AED')
  })

  it('渐变的坐标系与真源逐字相符', () => {
    const { mark } = renderMark()
    const gradient = mark.querySelector('linearGradient')
    const attribute = (name: string) => {
      const found = new RegExp(`${name}="([^"]+)"`).exec(source)?.[1]
      return [name, gradient?.getAttribute(name), found]
    }
    // 少写一个 `gradientUnits="userSpaceOnUse"`，渐变就会改成按包围盒铺——
    // 颜色一样、位置全错，而那是最不容易被眼睛发现的一种错。
    expect(attribute('gradientUnits')).toEqual(['gradientUnits', 'userSpaceOnUse', 'userSpaceOnUse'])
    expect(attribute('x1')).toEqual(['x1', '41', '41'])
    expect(attribute('y1')).toEqual(['y1', '16', '16'])
    expect(attribute('x2')).toEqual(['x2', '215', '215'])
    expect(attribute('y2')).toEqual(['y2', '241', '241'])
  })

  it('头那一笔（矩形）与眼睛里那两只洞，与真源逐字相符', () => {
    const { mark } = renderMark()
    const rect = mark.querySelector('rect[x="16"]')
    expect(rect === null).toBe(false)
    expect(['x', 'y', 'width', 'height', 'rx'].map((name) => rect?.getAttribute(name))).toEqual([
      '16',
      '34',
      '224',
      '188',
      '62',
    ])
    // 矩形指的是**真源里那两个 id**，不是另起的名字：改 id 就等于换了一张画稿。
    expect(rect?.getAttribute('fill')).toBe('url(#abx-mark)')
    expect(rect?.getAttribute('mask')).toBe('url(#abx-eyes)')

    const eyes = [...mark.querySelectorAll('mask circle')].map((circle) =>
      ['cx', 'cy', 'r'].map((name) => circle.getAttribute(name)),
    )
    expect(eyes).toEqual(eyesOf(source).map((eye) => [...eye]))
  })

  it('标志是装饰：aria-hidden，且名字由旁边那行文字承担', () => {
    const { mark, header } = renderMark()
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    // 标志自己不带名字：带了它就会与旁边那行字**重复**念一遍。
    expect(mark.getAttribute('aria-label')).toBeNull()
    expect(mark.getAttribute('role')).toBeNull()
    // 产品名在旁边，是**文字**不是图形——「图标永不单独承载语义」这条规矩的落点。
    expect(within(header as HTMLElement).getByRole('heading', { level: 1 }).textContent).toBe('abx')
  })
})
