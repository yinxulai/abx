// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * 托盘面板是**示意图**，不是产品截图。这一块最容易出的三种错：
 * 把它画得像是已经能用的产品（缺「示意」标注）、让读屏去念一堆装饰文字，
 * 以及**画着旧形态**——规格改了、图没跟上，于是图对着用户说假话。
 *
 * 所以下面每一条都对着 `product/tray-ui.md` 的一节：一排只有图标（§3）、
 * 名字只在 `aria-label` 里（§3.1 ③）、只画已安装的 agent（§3.1 ④）、
 * 状态先靠形状（§4）。删除掉的东西也各有一条断言守着——**删掉旧断言不等于删掉了旧形态**，
 * 少一条守卫，它下次就会悄悄长回来。
 */
afterEach(cleanup)

const figure = () => screen.getByRole('figure')

/** 面板卡片本体（`aria-hidden` 的那一块）。`figcaption` 在它外面。 */
const panel = () => {
  const mock = figure().querySelector('[aria-hidden="true"]')
  if (mock === null) throw new Error('面板示意没有对辅助技术隐藏')
  return mock
}

/**
 * 那一排方块。`role="img"` 是**画出来的方块**独有的：列表里那两个文件图标是
 * `aria-hidden` 的 svg，不带角色。方块带角色是为了让它的 `aria-label` 真的是个名字。
 */
const tiles = () => [...panel().querySelectorAll('[role="img"]')]
const tileLabels = () => tiles().map(tile => tile.getAttribute('aria-label'))

const tileFor = (name: string) => {
  const tile = tiles().find(candidate => (candidate.getAttribute('aria-label') ?? '').startsWith(name))
  if (tile === undefined) throw new Error(`面板里没有 ${name} 的方块`)
  return tile
}

/** 方块右下角那个点：实心 = 在跑，空心 = 没跑。 */
const dotOf = (tile: Element) => tile.lastElementChild

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('tray panel mock-up', { timeout: FULL_PAGE_TIMEOUT }, () => {
  it('is hidden from assistive technology, with the caption carrying the meaning', async () => {
    await renderApp('zh')

    expect(panel()).not.toBeNull()
    expect(textOf(figure().querySelector('figcaption'))).toContain('示意')
  })

  it('describes the panel in the language of the page', async () => {
    await renderApp('zh')
    // 副标题逐字等于真面板在跑那一档说的话（`packages/console` 的 `PanelCard`）。
    // 「气闸 / 凭据 / 舱」是把内部术语搬到了用户面前，一个都不许回来。
    expect(textOf(panel())).toContain('运行中 · 它拿不到你的密钥')
    expect(textOf(panel())).not.toMatch(/气闸|凭据|舱/)
    expect(textOf(figure())).toContain('共享给全部 agent')
    expect(textOf(figure())).toContain('只读')
    // 拖放区那一句逐字来自 `tray-ui.md` §7 第 3 条：面板内的文案只说面板。
    expect(textOf(figure())).toContain('拖到这里 → 全部 agent 立刻可见')
    // 计数由列表长度算出来，不另写一个数字：列表多一条，这里就得跟着变。
    expect(textOf(panel())).toContain('3 项')

    cleanup()
    await renderApp('en')
    expect(textOf(panel())).toContain('Running · it cannot reach your keys')
    expect(textOf(panel())).not.toMatch(/airlock|credential|cell/i)
    expect(textOf(figure())).toContain('Shared with every agent')
    expect(textOf(figure())).toContain('read-only')
    expect(textOf(figure())).toContain('Drop here → every agent sees it at once')
    expect(textOf(panel())).toContain('3 items')
  })

  it('draws the agent row as icon-only tiles, with the names kept in the labels', async () => {
    await renderApp('zh')

    // 一排只有图标，名字在悬停/聚焦时出现（§3）——所以这里**看不到**任何一个 agent 名。
    const visible = textOf(panel())
    expect(visible).not.toContain('Claude Code')
    expect(visible).not.toContain('OpenAI Codex CLI')

    // 但视觉上省掉的文字必须在别处补回来（§3.1 ③），否则读屏拿到的是无名方块。
    expect(tileLabels()).toEqual(['Claude Code · 运行中', 'OpenAI Codex CLI · 未运行'])
  })

  it('leaves the agent whose image is not built out of the row', async () => {
    await renderApp('zh')

    // 托盘只放已安装的 agent（§3.1 ④）。清单里今天恰好装了两个，
    // 少写的那个是 dsh——它只该出现在「Agent 一览」那一节的「镜像尚未构建」上。
    expect(tiles()).toHaveLength(2)
    expect(tileLabels().some(label => label?.startsWith('dsh'))).toBe(false)
  })

  it('draws no cell-count pill and no footer', async () => {
    await renderApp('zh')

    // 「N 舱」胶囊已经删掉：副标题只说「在不在跑、结果是什么」，舱数是管理面板的职责
    // （`design-system.md` §12）。这一条守着那个删除，别让它长回来。
    expect(textOf(panel())).not.toMatch(/\d+\s*舱/)
    // 托盘面板只有三件事（打开 agent、看共享内容、拖入），没有第四块 footer。
    for (const gone of ['审计流水', '停止全部', '退出']) {
      expect(textOf(figure())).not.toContain(gone)
    }

    cleanup()
    await renderApp('en')
    expect(textOf(panel())).not.toMatch(/\d+\s*cells/)
    for (const gone of ['Audit log', 'Stop all', 'Quit']) {
      expect(textOf(figure())).not.toContain(gone)
    }
  })

  it('carries each state in the shape of its tile, not only in colour', async () => {
    await renderApp('zh')

    const running = tileFor('Claude Code')
    const idle = tileFor('OpenAI Codex CLI')

    // 第一通道是形状：在跑的 2px 实线描边，没跑的虚线中性描边（§4）。
    expect(running.className).toContain('border-2')
    expect(idle.className).toContain('border-dashed')

    // 点同样分实心与空心。两档要是连形状都一样，状态就只剩颜色可读了。
    expect(dotOf(running)?.className).toContain('bg-mint')
    expect(dotOf(running)?.className).not.toContain('border')
    expect(dotOf(idle)?.className).toContain('border')
    expect(dotOf(idle)?.className).not.toContain('bg-')
  })
})
