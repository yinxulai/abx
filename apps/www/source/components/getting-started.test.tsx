// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULL_PAGE_TIMEOUT, renderApp, textOf } from '../test-support'

/**
 * 「开始使用」的判据是**它没有撒谎**：
 *
 * - 三步就是三步（多一步就说明这一节在往手册长）；
 * - 第一步必须写着现在还没有安装包 —— 这一节最容易退化成一句假的「点这里下载」；
 * - 拖一个目录进去之后会发生什么必须写出来（只读、递出来的东西当场打开），
 *   而不是「享受无缝体验」这种读完还是不知道会发生什么的话；
 * - **它描述的界面就是今天那个界面**：副标题上没有数字，「停止全部」不在托盘上。
 *   形态改过一轮之后，最容易留在这里的就是这类复述——它读起来仍然像最新的。
 */
afterEach(cleanup)

const section = () => screen.getByRole('region', { name: /三步|Three steps/ })

// 每一条都挂载整页，所以用整页那一档超时（理由见 `test-support.tsx`）。
describe('getting started', { timeout: FULL_PAGE_TIMEOUT }, () => {
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

    // 只对第三步那一段下判断：`section()` 里还有下面那条 note，两处的用词不一样。
    const drop = textOf(within(section()).getAllByRole('listitem')[2])
    expect(drop).toContain('共享条目')
    expect(drop).toContain('只读')
    // 产物是**递出来即打开**，不是「写进面板里一个叫取回区的地方、点一下到访达」：
    // 面板没有取回列表，也没有打开文件夹的按钮（`packages/console` 里搜不到），
    // 而打开的是**文件本身**、还受后缀限制。这两句当初读起来像最新的，
    // 指的却是两个不存在的东西。
    expect(drop).toContain('给你看')
    expect(drop).toContain('不是替你执行')
    expect(drop).not.toContain('取回区')
    expect(drop).not.toContain('访达')
    // 停掉什么、什么会留下 —— 这一节里最容易被误读的一句，仍然要在。
    expect(textOf(section())).toContain('不删你的原文件')

    // 英文侧是另一份字，得单独判一遍：只说中文改完了，英文那句假界面会照样待在线上。
    cleanup()
    await renderApp('en')
    const dropEn = textOf(within(section()).getAllByRole('listitem')[2])
    expect(dropEn).toContain('shown to you')
    expect(dropEn).toContain('not run for you')
    expect(dropEn).not.toContain('Finder')
    expect(dropEn).not.toContain('outbox')
  })

  it('describes the panel header the way the panel actually draws it', async () => {
    await renderApp('zh')

    const body = textOf(section())
    // 副标题说的是「在不在跑」，没有数字：`design-system.md` §12 把舱数判给了管理面板。
    // 这里写「有几个在跑」，就是把用户送到一个不存在的读数前面。
    expect(body).toContain('它拿不到你的密钥')
    expect(body).not.toContain('几个舱在跑')
    // 托盘面板上不出现「气闸」与「凭据」（`functional-design.md` §0.2 ②：术语要换算成后果），
    // 这一节也就不许替它说这两个词。
    expect(body).not.toContain('气闸')
    expect(body).not.toContain('凭据')
  })

  it('says where the stop-everything button is instead of pointing at the tray', async () => {
    await renderApp('zh')

    // 托盘面板的 footer 整个不存在了；「一次停掉全部」在管理面板的 header 里
    // （`functional-design.md` §13）。位置说错，用户就去托盘上找一个没有的按钮。
    const body = textOf(section())
    expect(body).toContain('管理面板')
    expect(body).toContain('一次就停掉全部')
    expect(body).not.toContain('停的是舱')
    // 停掉什么、什么会留下 —— 这一节里最容易被误读的一句，仍然要在。
    expect(body).toContain('不删你的原文件')
  })
})
