import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * 引用与定义的封口：**每一个 `var(--x)` 都必须有 `--x:` 落地**。
 *
 * 这条测试防的是一种**静默**的坏法。`var(--x)` 里的 `--x` 不存在时，CSS 不会报错，
 * 也不会退回继承色以外的任何东西——它只是**在这个属性上什么都不写**，于是颜色
 * 退回继承来的那一档。页面照渲染，肉眼多半看不出来，`styles.test.ts` 也全绿：
 * 那份文件对的是「文档里的表 vs 样式表里的定义」，而这里坏掉的是一次**引用**。
 *
 * 它是真发生过的：文字从两级重写成四级（`--text` → `--text-primary` 等）之后，
 * 新写的 CSS 里仍旧引用着 `--text` / `--text-muted`。那两个名字已经删了，
 * 引用它们的地方于是全部退回继承色——测试一条都没红。扫描是事后手工做的，
 * 而下一次不会有人记得做。
 *
 * 只读文本：这是两份声明之间对账，与渲染无关。
 */

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

/**
 * 注释会**谈论**令牌（「`var(--accent-deep, var(--accent))` 那套回退写法救不了」），
 * 那些不是引用。把注释整段抹成空白，**保留换行**，这样行号不变。
 */
const code = css.replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))

const lineAt = (index: number): number => code.slice(0, index).split('\n').length

/** 每一处 `var(--x)`，带不带 fallback 都算：`var(--x, y)` 里的 `--x` 同样是硬依赖。 */
const references = [...code.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)].map((match) => ({
  name: match[1] ?? '',
  line: lineAt(match.index),
  fallback: match[2] === ',',
}))

/** 每一处 `--x:` 声明。`var(--x)` 后面跟的是 `,` 或 `)`，不会被当成定义，所以不必再筛。 */
const defined = new Set([...code.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ''))

/**
 * 允许在样式表里没有定义的引用。**这份表要一直小到能一眼看完**，每一条都得说得出理由；
 * 往里加一条 = 宣布「这个令牌由别处提供」，那是一个需要被评审的决定，不是顺手。
 */
const EXTERNALLY_DEFINED = new Map<string, string>([
  [
    '--abx-agent-color',
    'AgentStatusRow 按 agent 的品牌色内联写在 tile 的 style 上（没有品牌色的 agent 不写，走 transparent）',
  ],
])

describe('样式表里的令牌引用都有定义', () => {
  it('扫描本身不能空转', () => {
    // 正则写歪了、文件路径改了，都会让下面那条断言在「零个引用」上白白通过。
    expect(references.length).toBeGreaterThan(20)
    expect(defined.size).toBeGreaterThan(20)
    // 「带 fallback 的也抽」是这条测试的一半：漏掉这种写法，`var(--x, reset)` 就能带着
    // 一个不存在的 `--x` 混过去（它只是永远取 fallback，坏得更隐蔽）。
    expect(references.filter((entry) => entry.fallback).length).toBeGreaterThan(0)
  })

  it('白名单只认已知的那几条，且每条都有写的理由', () => {
    expect([...EXTERNALLY_DEFINED.keys()]).toEqual(['--abx-agent-color'])
    for (const [name, reason] of EXTERNALLY_DEFINED) expect([name, reason.length > 10]).toEqual([name, true])
  })

  it('每一个被引用的令牌都有定义', () => {
    const missing = references
      .filter((entry) => !defined.has(entry.name) && !EXTERNALLY_DEFINED.has(entry.name))
      .map((entry) => `${entry.name}（styles.css:${entry.line}）`)
    // 报出**名字 + 行号**：这条测试的用处全在失败信息里——「少了一个令牌」不带位置，
    // 拿到的人还得自己找。名字里带颜色时，找到它也就等于找到了那处属性。
    expect(missing).toEqual([])
  })
})
