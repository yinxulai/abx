import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * 文档与样式表的对账。
 *
 * `apps/docs/specs/product/design-system.md` 是颜色、字号、间距、圆角的唯一来源，
 * `styles.css` 是它的落地。两边会漂移，而且漂移是**静默**的：改一处十六进制值、
 * 加一档 15px 的字号，界面照跑，没人会红。所以这里把文档里的表格读出来，
 * 逐条比对样式表里的声明——不是另抄一份映射表（那种表自己就会过期）。
 *
 * 只读文本，不需要浏览器：对账是「文档里写的数」与「样式表里写的数」之间的事，
 * 与渲染无关。渲染出来的对比度由 design-review-loop 的审计脚本量（见 v3/NOTES.md）。
 */

const doc = readFileSync(new URL('../../../apps/docs/specs/product/design-system.md', import.meta.url), 'utf8')
/** 注释里也会写 `1.29:1` 这种带冒号的片段，先摘掉再解析，免得把注释当声明。 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '')

/** 文档里第 `heading` 节到 `until` 之间的那一段。 */
function section(heading: string, until: string): string {
  const start = doc.indexOf(heading)
  const end = doc.indexOf(until, start + heading.length)
  if (start === -1 || end === -1) throw new Error(`文档里找不到「${heading}」到「${until}」这一段`)
  return doc.slice(start, end)
}

/** 一条规则：`selector { body }`。媒体查询那一层会被跳过，取到的是里面的规则。 */
interface Rule {
  readonly selector: string
  readonly body: string
}

const rules: readonly Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
  const selector = match[1]?.trim()
  const body = match[2]?.trim()
  return selector === undefined || body === undefined || body === '' ? [] : [{ selector, body }]
})

/** 一条规则里的自定义属性（`--name: value`），值里的空白压成单空格。 */
function tokensOf(rule: Rule, prefix = '--'): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const chunk of rule.body.split(';')) {
    const colon = chunk.indexOf(':')
    if (colon === -1) continue
    const name = chunk.slice(0, colon).trim()
    const value = chunk.slice(colon + 1).replaceAll(/\s+/g, ' ').trim()
    if (name.startsWith(prefix) && value !== '') found.set(name, value)
  }
  return found
}

const rootRules = rules.filter((rule) => rule.selector === ':root')
/** 深色那一组在媒体查询里，选择器同样是 `:root`，所以按出现顺序取第二份。 */
const lightTokens = tokensOf(rootRules[0] ?? { selector: '', body: '' })
const darkTokens = tokensOf(rootRules[1] ?? { selector: '', body: '' })

/** 一段声明里某个属性的值。 */
function valueOf(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim()
}

/** 文档 §2 的颜色表：`| \`--token\` | \`#RRGGBB\` | …`。 */
function documentedColours(source: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/^\|\s*`(--[a-z-]+)`\s*\|\s*`(#[0-9a-f]{6})`/gim)) {
    found.set(match[1] ?? '', (match[2] ?? '').toLowerCase())
  }
  return found
}

/** 一组令牌里那些「值是颜色」的项：多长出一个颜色令牌，这里就多一个。 */
function colourTokens(source: ReadonlyMap<string, string>): string[] {
  return [...source.entries()].flatMap(([name, value]) => (/^#[0-9a-f]{6}$/i.test(value) ? [name] : []))
}

const documentedDark = documentedColours(section('### 深色', '### 浅色'))
const documentedLight = documentedColours(section('### 浅色', '## 3.'))

describe('颜色：文档的两张表与两套主题逐条对上', () => {
  it('两张表都读到了东西（对账本身不能空转）', () => {
    expect(documentedLight.size).toBeGreaterThanOrEqual(9)
    expect(documentedDark.size).toBeGreaterThanOrEqual(8)
  })

  it('浅色表里的每个颜色都在 :root 里逐字落地', () => {
    for (const [name, value] of documentedLight) expect([name, lightTokens.get(name)?.toLowerCase()]).toEqual([name, value])
  })

  it('深色表里的每个颜色都在 prefers-color-scheme: dark 里逐字落地', () => {
    for (const [name, value] of documentedDark) expect([name, darkTokens.get(name)?.toLowerCase()]).toEqual([name, value])
  })

  it('两套主题的颜色令牌不多不少', () => {
    // `--accent-deep` 是浅色独有的第二档（文档 §2 讲清了为什么）；
    // 反过来，深色不该自己长出一个文档没写的颜色——那多半是「顺手加个色」的开头。
    expect(colourTokens(lightTokens).sort()).toEqual([...documentedLight.keys()].sort())
    expect(colourTokens(darkTokens).sort()).toEqual([...documentedDark.keys()].sort())
  })

  it('浅色定义过的颜色，深色里都有交代，不会悄悄沿用浅色那一档', () => {
    // 这是 audit.mjs 在深色下量出来的真错：`--accent-deep` 只在浅色的 `:root` 里定义过，
    // 深色不写它就**继承浅色的墨绿**——`var(--accent-deep, var(--accent))` 那种回退写法
    // 救不了，它只在属性完全没定义时才生效，而浅色的 `:root` 已经定义过了。
    // 深色块用的是媒体查询覆盖，所以「深色想要什么色」必须逐个重说一遍：这条测试
    // 把所有浅色令牌都要一遍，漏掉哪个都会红。
    const lightColours = colourTokens(lightTokens)
    expect(lightColours.length).toBeGreaterThanOrEqual(9)
    expect(lightColours.filter((name) => !darkTokens.has(name))).toEqual([])
    // 深色下第二档不存在：这个名字在深色里指回 `--accent`（9.91:1，当正文也够）。
    expect(lightTokens.get('--accent-deep')).toBe('#0a7268')
    expect(darkTokens.get('--accent-deep')).toBe('var(--accent)')
  })

  it('深色块里除了文档那一档色，只允许指向本块内的别名', () => {
    // 别名指到浅色独有的令牌上，就是上一个测试说的那个坑；指到一个不存在的名字则是打错字。
    for (const [name, value] of darkTokens) {
      if (/^#[0-9a-f]{6}$/i.test(value)) continue
      const alias = /^var\((--[a-z-]+)\)$/.exec(value)?.[1]
      expect([name, alias === undefined ? false : darkTokens.has(alias)]).toEqual([name, true])
    }
  })

  it('浅色下点缀色有两档，因为图形够的那一档当正文不够', () => {
    // 这是文档里点名「最容易犯的错」的一处：浅色下拿 `--accent` 写正文只有 4.13:1。
    expect(lightTokens.get('--accent')).toBe('#0e8c80')
    expect(lightTokens.get('--accent-deep')).toBe('#0a7268')
  })
})

describe('字号：五档封顶，字重只用 400 / 500 / 600', () => {
  /** 文档 §3 的表：`| \`--text-2xs\` | 11 | 14 | …`。 */
  const rows = [...section('## 3. 字号与字重', '## 4.').matchAll(/^\|\s*`(--text-[a-z0-9]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gim)].map(
    (match) => ({ name: match[1] ?? '', size: `${match[2] ?? ''}px`, leading: `${match[3] ?? ''}px` }),
  )

  it('五档，不多不少', () => {
    expect(rows.map((row) => row.name)).toEqual([
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-base',
      '--text-lg',
    ])
  })

  it('每一档的字号与行高都逐字落地', () => {
    for (const row of rows) {
      expect([row.name, lightTokens.get(row.name)]).toEqual([row.name, row.size])
      expect([`${row.name}-leading`, lightTokens.get(`${row.name}-leading`)]).toEqual([`${row.name}-leading`, row.leading])
    }
  })

  it('样式表里没有第七档字号', () => {
    // `--text-*` 里既有字号也有颜色（`--text` / `--text-muted`），还有成对的行高
    // （`--text-sm-leading`）：按值是不是像素、名字带不带 `-leading` 区分。
    const sizes = [...lightTokens.entries()].flatMap(([name, value]) =>
      /^--text-/.test(name) && /px$/.test(value) && !name.endsWith('-leading') ? [name] : [],
    )
    expect(sizes.sort()).toEqual(rows.map((row) => row.name).sort())
  })

  it('用到字号与字重的地方只从令牌里取', () => {
    // 硬写一个 15px、或 font-weight: 550，就是体系外的第七档；它不该有藏身之处。
    const used = rules.flatMap((rule) =>
      [...rule.body.matchAll(/(?:^|;)\s*(font-size|font-weight)\s*:\s*([^;]+)/g)].map(
        (match) => `${rule.selector} → ${match[1]}: ${match[2]?.trim()}`,
      ),
    )
    expect(used.length).toBeGreaterThan(10)
    for (const entry of used) expect(entry).toMatch(/(font-size: var\(--text-[a-z0-9]+\)|font-weight: (400|500|600))$/)
  })
})

describe('间距与圆角：刻度之外没有值', () => {
  const scale = /间距是[^：]*：`([^`]+)`/.exec(doc)?.[1]?.split(' / ').map(Number) ?? []

  it('文档里那串刻度读到了', () => {
    expect(scale).toEqual([2, 4, 6, 8, 12, 16, 20, 24, 32])
  })

  it('刻度上的每一档都有同名令牌，且没有刻度外的令牌', () => {
    for (const step of scale) expect([`--space-${step}`, lightTokens.get(`--space-${step}`)]).toEqual([`--space-${step}`, `${step}px`])
    expect([...lightTokens.keys()].filter((name) => name.startsWith('--space-')).sort()).toEqual(
      scale.map((step) => `--space-${step}`).sort(),
    )
  })

  it('间距只从刻度上取（窗口几何那一档除外）', () => {
    // 14px、10px 这种「看起来差不多」的值是漂移的开始：它们不属于任何一档。
    const used = rules.flatMap((rule) =>
      [...rule.body.matchAll(/(?:^|;)\s*(padding|gap|row-gap|column-gap|margin|margin-\w+|padding-\w+)\s*:\s*([^;]+)/g)].flatMap(
        (match) => (match[2] ?? '').trim().split(/\s+/).map((value) => `${rule.selector} → ${match[1]}: ${value}`),
      ),
    )
    expect(used.length).toBeGreaterThan(10)
    for (const entry of used) expect(entry).toMatch(/→ [a-z-]+: (0|var\(--space-\d+\)|var\(--panel-gutter\))$/)
  })

  it('圆角是 4 / 6 / 10，徽标是 999 的胶囊', () => {
    const radii = [...doc.matchAll(/`(--radius-[a-z]+): (\d+)`/g)].map((match) => ({ name: match[1] ?? '', value: `${match[2] ?? ''}px` }))
    expect(radii.map((radius) => radius.name)).toEqual(['--radius-sm', '--radius-md', '--radius-lg'])
    for (const radius of radii) expect([radius.name, lightTokens.get(radius.name)]).toEqual([radius.name, radius.value])
    // 胶囊那一档也照文档取名字：文档里写的是「徽标用 `999`（胶囊，`--radius-pill`）」。
    const pill = /`999`（胶囊，`(--radius-[a-z]+)`）/.exec(doc)?.[1]
    expect(pill).toBeDefined()
    expect([...lightTokens.entries()].filter(([, value]) => value === '999px').map(([name]) => name)).toEqual([pill])
  })

  it('用到圆角的地方只从令牌里取', () => {
    const used = rules.flatMap((rule) => {
      const value = valueOf(rule.body, 'border-radius')
      return value === undefined ? [] : [`${rule.selector} → border-radius: ${value}`]
    })
    expect(used.length).toBeGreaterThan(5)
    for (const entry of used) expect(entry).toMatch(/→ border-radius: var\(--radius-[a-z]+\)$/)
  })
})

describe('状态：样式表里的分段与组件能发出的状态一致', () => {
  const component = readFileSync(new URL('./components/AgentStatusRow.tsx', import.meta.url), 'utf8')
  /** 组件能发出的状态，从联合类型里读——不在这里另抄一份。 */
  const states = [...(/(?:type AgentTileState =)([^\n]+)/.exec(component)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
    (match) => match[1] ?? '',
  )

  it('组件确实声明了状态联合类型', () => {
    // 两档，不是三档：托盘里只有已安装的 agent，所以「不可用」那一档不存在
    // （`tray-ui.md` §3.1 ④）。多出一档就说明有 agent 被放进了这一排。
    expect(states).toEqual(['running', 'idle'])
  })

  it('每一个状态在样式表里都有自己的一段，且没有第四段', () => {
    const styled = rules.flatMap((rule) => {
      const state = /\.abx-agent\[data-state='([a-z-]+)'\]/.exec(rule.selector)?.[1]
      return state === undefined ? [] : [state]
    })
    expect([...new Set(styled)].sort()).toEqual([...states].sort())
  })

  it('agent 名字不随状态变淡（现在名字住在 tooltip 里）', () => {
    // 整套改动的缘由就是这一条：原来「未运行」同时被削了两处（灰底 + 弱化文字），
    // 于是最该点的那一个看起来像禁用。名字搬进 tooltip 之后规矩不变——
    // 它是这一面上**唯一**的文字，仍然只有一个颜色来源，且与 `data-state` 无关。
    const coloured = rules.filter((rule) => rule.selector.includes('.abx-agent-tip') && valueOf(rule.body, 'color') !== undefined)
    expect(coloured.map((rule) => rule.selector)).toEqual(['.abx-agent-tip'])
    expect(valueOf(coloured[0]?.body ?? '', 'color')).toBe('var(--text)')
  })
})

describe('托盘：agent 那一排只有图标（tray-ui.md §3、§3.1）', () => {
  const component = readFileSync(new URL('./components/AgentStatusRow.tsx', import.meta.url), 'utf8')

  const rule = (selector: string): string => rules.find((entry) => entry.selector === selector)?.body ?? ''

  it('每个方块都是 44×44', () => {
    // 44 不是审美：指针/触控目标的下限就是它，而审计查的就是这一条（§3.1 ①）。
    expect([valueOf(rule('.abx-agent'), 'width'), valueOf(rule('.abx-agent'), 'height')]).toEqual(['44px', '44px'])
  })

  it('一排折行，不横滚', () => {
    const agents = rule('.abx-agents')
    expect([valueOf(agents, 'flex-wrap'), valueOf(agents, 'gap')]).toEqual(['wrap', 'var(--space-8)'])
    // 左对齐：个数从 1 变到 7 时不会跳位（§3.1 ①）。
    expect(valueOf(agents, 'justify-content')).toBe('flex-start')
    // 横滚的写法一个都不许有：面板固定 422 宽，横滚会让这一排变成要摸黑滑动的带子。
    expect(agents).not.toMatch(/overflow/)
    expect(css).not.toMatch(/overflow-x/)
  })

  it('名字在悬停和键盘聚焦时都出现，而且不是原生 title', () => {
    // 只做 `:hover` 等于把名字只给了鼠标用户，触屏与键盘用户永远看不到它（§3.1 ②）。
    // 两条选择器写在同一条规则里，删掉任何一条都会让这条断言红。
    const shown = rules.find(
      (entry) => entry.selector.includes('.abx-agent-tip') && entry.selector.includes(':hover'),
    )
    expect(shown?.selector).toContain('.abx-agent:focus-visible .abx-agent-tip')
    expect(valueOf(shown?.body ?? '', 'display')).toBe('block')
    // 默认是藏起来的，否则它就一直占着卡片。
    expect(valueOf(rule('.abx-agent-tip'), 'display')).toBe('none')
    // 原生 `title` 延迟约 1 秒、样式不受控，而名字是这一面上唯一的文字。
    expect(component).not.toMatch(/\stitle=/)
  })

  it('状态先由形状承载：实心点与空心圈各一段', () => {
    // 文字没了之后，形状要是也一样，状态就只剩颜色一个通道——那是设计体系禁止的。
    expect(valueOf(rule('.abx-agent-dot'), 'background')).toBe('transparent')
    // 空心圈用 `--text`：`--border-strong` 在 tile 那种「掺了品牌色的中性底」上只有
    // 2.84:1，低于状态标记要求的 3:1（实测，见 styles.css 里的那段注释）。
    expect(valueOf(rule('.abx-agent-dot'), 'border')).toContain('var(--text)')
    expect(valueOf(rule(".abx-agent[data-state='running'] .abx-agent-dot"), 'background')).toBe('var(--accent)')
    expect(valueOf(rule(".abx-agent[data-state='running'] .abx-agent-dot"), 'border')).toBe('0')
  })
})
