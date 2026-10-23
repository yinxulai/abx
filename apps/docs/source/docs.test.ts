/**
 * 文档站的自检。
 *
 * 这一组测试守着三件容易悄悄坏掉的事：
 *
 * 1. **导航与文件对得上**：`clarify.ts` 里声明的每一页都有中文 MDX，反过来中文 MDX
 *    也都出现在导航里；站内链接都能落到某个真实页面。少一个文件、链接写错一个 slug，
 *    站点不会报错，只会安静地 404——所以必须由测试来喊。
 * 2. **文档数据不跟代码漂移**：agent 的名字、命令、配置落点、镜像与历史目录只有一个
 *    来源——清单（`packages/contracts/source/agents.ts`）。页面里的 Markdown 数据
 *    （路径、镜像名）在这里逐条对照清单校验。
 * 3. **不该进使用者文档的东西不进**：明文凭据、内部术语（`cellId` / `lease`）。
 *
 * 译制进度表也在 `source/README.md`，本文件对照它检查英文文件是否存在，
 * 免得表里写「已译」而文件没建。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_DEFINITIONS,
  AGENT_IMAGE_UNBUILT,
  agentImageRef,
  agentManifestProblems,
} from '@abx/contracts/agents'
import { abxConfigSchema } from '@abx/contracts/schema'
import { describe, expect, it } from 'vitest'

import clarifyConfig from '../clarify'
import { AGENT_COUNT, AGENT_DOCS, AGENTS_IMAGE_UNBUILT } from './data/agents'

const sourceDir = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(sourceDir, '..')

// ── clarify.ts 的导航形状 ────────────────────────────────────────────────
// 只声明用得到的部分：这里要的是「有哪些 page」，不是站点配置的全部类型。
interface NavPage {
  readonly page?: string
  readonly group?: unknown
  readonly pages?: readonly NavPage[]
}

const navigation = (clarifyConfig as unknown as {
  readonly navigation: { readonly tabs: readonly { readonly pages: readonly NavPage[] }[] }
}).navigation

const pageSlugs = [
  ...new Set(
    navigation.tabs.flatMap((tab) =>
      tab.pages.flatMap((entry) =>
        entry.page ? [entry.page] : (entry.pages ?? []).flatMap((child) => (child.page ? [child.page] : [])),
      ),
    ),
  ),
].sort()

const mdxPath = (locale: string, slug: string): string =>
  join(sourceDir, locale, slug === 'index' ? 'index.mdx' : `${slug}.mdx`)

const readMdx = (locale: string, slug: string): string => readFileSync(mdxPath(locale, slug), 'utf8')

const zhSlugs = readdirSync(join(sourceDir, 'zh'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => listMdxSlugs(join(sourceDir, 'zh', entry.name), entry.name))

function listMdxSlugs(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return listMdxSlugs(join(dir, entry.name), `${prefix}/${entry.name}`)
    return entry.name.endsWith('.mdx') ? [`${prefix}/${entry.name.replace(/\.mdx$/, '')}`] : []
  })
}

const zhIndexAndPages = [...zhSlugs, 'index'].sort()

const frontmatter = (text: string): Record<string, string> => {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!match) return {}
  return Object.fromEntries(
    match[1]
      .split('\n')
      .filter((line) => /^[a-zA-Z][\w-]*:/.test(line))
      .map((line) => {
        const [, key, value] = /^([\w-]+):\s*(.*)$/.exec(line) ?? []
        return [key ?? '', value ?? '']
      }),
  )
}

// 站点上真实存在的路由：默认语言有裸路径与 `/zh` 两种别名，英文在 `/en` 下。
const routes = new Set<string>(['/', '/zh', '/en'])
for (const slug of pageSlugs) {
  for (const prefix of ['', '/zh', '/en']) {
    routes.add(slug === 'index' ? `${prefix}/` || '/' : `${prefix}/${slug}`)
  }
}

// 页面上允许出现的宿主路径：清单登记的配置文件，加上与它们同目录的凭据文件，
// 以及「历史目录」这个概念在示例里用到的目录名。
const credentialNeighbours = [
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  '~/.pi/agent/auth.json',
  '~/.claude',
  '~/.codex',
  '~/.dsh',
  // 举例说明「不该给 agent 的东西」时用的路径，与 agent 数据无关。
  '~/.ssh',
  // abx 自己在宿主上的持久化目录，以及按实例存的 agent 历史。
  '~/.abx',
  '~/.abx/instances',
]
const knownHostPaths = new Set<string>([
  ...AGENT_DEFINITIONS.flatMap((agent) => agent.configFiles.map((file) => file.path)),
  ...credentialNeighbours,
])

const mdxFiles = [
  ...zhIndexAndPages.map((slug) => ({ locale: 'zh', slug, path: mdxPath('zh', slug) })),
  { locale: 'en', slug: 'index', path: mdxPath('en', 'index') },
]

describe('导航与文件', () => {
  it('导航里每一页都有中文 MDX', () => {
    for (const slug of pageSlugs) {
      expect(existsSync(mdxPath('zh', slug)), `缺少 source/zh/${slug}.mdx`).toBe(true)
    }
  })

  it('每个中文 MDX 都在导航里（没有孤儿页）', () => {
    expect(zhIndexAndPages).toEqual(pageSlugs)
  })

  it('每页都有 title 与 description', () => {
    for (const file of mdxFiles) {
      const meta = frontmatter(readFileSync(file.path, 'utf8'))
      expect(meta.title, `${file.path} 缺 title`).toBeTruthy()
      expect(meta.description, `${file.path} 缺 description`).toBeTruthy()
    }
  })

  it('站内链接都能落到某个页面或 public 资源', () => {
    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      const links = [
        ...text.matchAll(/(?<!!)\[[^\]]*\]\((\/[^)\s]*)\)/g),
        ...text.matchAll(/href="(\/[^"]*)"/g),
      ].map((match) => match[1] ?? '')
      for (const link of links) {
        const target = link.split('#')[0] ?? ''
        if (routes.has(target)) continue
        expect(existsSync(join(docsDir, 'public', target)), `${file.path} 的链接 ${link} 无对应页面或资源`).toBe(
          true,
        )
      }
    }
  })

  it('英文缺译的页面靠回退而不是 404', () => {
    for (const slug of pageSlugs) {
      const en = mdxPath('en', slug)
      if (existsSync(en)) continue
      // 没有英文文件时必须靠 `missing: 'fallback'` 顶上；配置里必须仍是 fallback。
      expect((clarifyConfig as unknown as { locales: { missing: string } }).locales.missing).toBe('fallback')
    }
  })
})

describe('文档数据与清单一致', () => {
  it('agent 数量与清单一致', () => {
    expect(AGENT_COUNT).toBe(AGENT_DEFINITIONS.length)
    expect(AGENT_DOCS.map((agent) => agent.id)).toEqual(AGENT_DEFINITIONS.map((agent) => agent.id))
  })

  it('名字、命令、上游、状态、配置落点都来自清单', () => {
    AGENT_DEFINITIONS.forEach((definition, index) => {
      const doc = AGENT_DOCS[index]
      expect(doc?.label).toBe(definition.label)
      expect(doc?.command).toBe([definition.command, ...definition.args].join(' '))
      expect(doc?.upstreamId).toBe(definition.upstreamId)
      expect(doc?.status).toBe(definition.status)
      expect(doc?.oswClientKey).toBe(definition.oswClientKey)
      expect(doc?.baseUrlEnv).toBe(definition.baseUrlEnv)
      expect(doc?.tokenEnv).toBe(definition.tokenEnv)
      expect(doc?.cellTokenVia).toBe(definition.cellTokenVia)
      expect(doc?.registeredFiles.map((file) => file.path)).toEqual(
        definition.configFiles.map((file) => file.path),
      )
      expect(doc?.generatedFiles.map((file) => file.path)).toEqual(
        definition.configFiles.filter((file) => file.generated).map((file) => file.path),
      )
    })
  })

  it('镜像与历史目录都来自每个 agent 自己的清单条目', () => {
    AGENT_DEFINITIONS.forEach((definition, index) => {
      const doc = AGENT_DOCS[index]
      // 镜像取自这一条的 `image.repository` / `image.version`，不是任何全局兜底值。
      expect(doc?.image.repository).toBe(definition.image.repository)
      expect(doc?.image.version).toBe(definition.image.version)
      expect(doc?.image.reference).toBe(agentImageRef(definition))
      expect(doc?.image.built).toBe(definition.image.version !== AGENT_IMAGE_UNBUILT)
      // 历史目录取自这一条的 `statePaths`（含挂载权限）。
      expect(doc?.statePaths).toEqual(definition.statePaths)
    })
    // 「哪些 agent 的镜像还没构建」也由清单现算，页面不自己判断。
    expect(AGENTS_IMAGE_UNBUILT).toEqual(
      AGENT_DEFINITIONS.filter((agent) => agent.image.version === AGENT_IMAGE_UNBUILT).map((agent) => agent.id),
    )
  })

  it('没有全局默认镜像，镜像只能来自 agent 自己的条目', () => {
    // 配置里不写 `session.image` 时它就是 `null`（不是某个镜像名）：
    // 没有全局默认值，起舱用的是所选 agent 自己的那一条。
    expect(abxConfigSchema.parse({}).session.image).toBeNull()

    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      // 镜像名只能经数据模块注入，不许手抄常量；裸镜像也不许再作为「默认」出现。
      expect(text, `${file.path} 手抄了裸镜像`).not.toContain('node:22-slim')
      for (const definition of AGENT_DEFINITIONS) {
        expect(text, `${file.path} 手抄了镜像 ${definition.image.repository}`).not.toContain(
          definition.image.repository,
        )
      }
    }
  })

  it('镜像为空或未钉住版本时，清单守卫会拒绝（文档不另写一份实现）', () => {
    const base = AGENT_DEFINITIONS.find((agent) => agent.id === 'claude')
    // 没有基准条目这条断言就失去了意义：宁可失败，也不要拿 undefined 拼出一条假清单。
    if (base === undefined) throw new Error('清单里没有 claude，无法验证镜像守卫。')

    // 真清单本身必须过得了同一个守卫；它同时也是 `pnpm lint` 的判据。
    expect(agentManifestProblems()).toEqual([])

    const emptyVersion = agentManifestProblems([
      { ...base, image: { repository: base.image.repository, version: '' } },
    ])
    expect(emptyVersion.join('\n')).toContain('image.version 是空的')

    const unpinned = agentManifestProblems([
      { ...base, image: { repository: base.image.repository, version: 'latest' } },
    ])
    expect(unpinned.join('\n')).toContain('image.version 是 latest')

    const emptyRepository = agentManifestProblems([
      { ...base, image: { repository: ' ', version: base.image.version } },
    ])
    expect(emptyRepository.join('\n')).toContain('image.repository 是空的')
  })

  it('未构建的镜像写成「尚未构建」，不是「尚未指定」', () => {
    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      expect(text, `${file.path} 把「未构建」写成了「未指定」`).not.toContain('尚未指定')
      expect(text, `${file.path} 把「未构建」写成了「还没指定」`).not.toContain('还没指定')
    }
    // 页面上的「哪些镜像还没建」由数据模块现算，不是手写一张名单。
    for (const slug of ['agents/available', 'limits/troubleshooting', 'limits/limitations']) {
      const text = readMdx('zh', slug)
      expect(text, `${slug} 没有引用数据模块的未构建名单`).toContain('AGENTS_IMAGE_UNBUILT')
    }
  })

  it('页面里出现的宿主路径都在清单或凭据邻居名单里', () => {
    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      // 只校验 `~/...` 这种宿主路径写法，代码块里的容器路径不在其列。
      for (const match of text.matchAll(/~\/[\w./-]+/g)) {
        // 去掉路径末尾的分隔符与省略号写法（`~/.abx/…/history` 里的 `~/.abx/`）。
        const path = (match[0] ?? '').replace(/[/.]+$/, '')
        expect(knownHostPaths.has(path), `${file.path} 出现未登记的路径 ${path}`).toBe(true)
      }
    }
  })

  it('清单里每个生成配置都经数据模块暴露给页面（清单加了文档跟着变）', () => {
    const rendered = new Set(AGENT_DOCS.flatMap((agent) => agent.registeredFiles.map((file) => file.path)))
    for (const file of AGENT_DEFINITIONS.flatMap((agent) =>
      agent.configFiles.filter((config) => config.generated),
    )) {
      expect(rendered.has(file.path), `数据模块没有暴露 ${file.path}`).toBe(true)
    }
  })

  it('展示配置落点的页面从数据模块读，而不是手写', () => {
    for (const slug of ['agents/available', 'inside/config']) {
      const text = readMdx('zh', slug)
      expect(text, `${slug} 没有引用 source/data/agents`).toContain('data/agents')
      expect(text).toMatch(/AGENT_DOCS|claude/)
    }
  })
})

describe('不该出现在使用者文档里的东西', () => {
  it('没有明文凭据', () => {
    const patterns = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/]
    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      for (const pattern of patterns) {
        expect(pattern.test(text), `${file.path} 出现疑似真凭据`).toBe(false)
      }
    }
  })

  it('没有内部术语', () => {
    for (const file of mdxFiles) {
      const text = readFileSync(file.path, 'utf8')
      expect(/\bcellId\b/i.test(text), `${file.path} 出现内部术语 cellId`).toBe(false)
      expect(/\blease\b/i.test(text), `${file.path} 出现内部术语 lease`).toBe(false)
    }
  })
})

describe('界面描述与真面板一致', () => {
  // 这几句描述的是 `packages/console` 里那个真面板，所以真面板改了、这里没跟上，
  // 测试必须喊。**只删旧句不算修好**——旧形态会换一种写法长回来，所以每一条都同时
  // 断言「新句在」与「旧词不在」。
  const firstRun = readMdx('zh', 'getting-started/first-run')
  const installation = readMdx('zh', 'getting-started/installation')
  const limitations = readMdx('zh', 'limits/limitations')

  it('起舱说的是方块的形状，不是头部计数', () => {
    // 头部没有计数（`design-system.md` §8：数量归管理面板）。
    expect(firstRun).toContain('右下角的点变成实心')
    expect(firstRun).not.toContain('头部计数加一')
  })

  it('取回写的是落地即打开，不是「面板里的列表 + 确认」', () => {
    // `functional-design.md` §13：面板只列共享项，`publish` 落地即打开。
    expect(firstRun).toContain('落地即')
    expect(firstRun).not.toContain('出现在面板的「取回」里')
    expect(firstRun).not.toContain('要你点一下确认')
  })

  it('「停止全部」挂在管理面板上，不挂在托盘上', () => {
    expect(firstRun).toContain('管理面板')
    expect(firstRun).not.toContain('托盘与气闸继续运行')
  })

  it('安装页不承诺面板上没有的读数与方块数', () => {
    // 图上画的是两个方块（dsh 镜像未构建，不进托盘），面板里也没有「几个在跑」这个读数。
    expect(installation).toContain('两个 agent 方块')
    expect(installation).not.toContain('三个 agent 方块')
    expect(installation).not.toContain('几个 agent 在跑')
    expect(installation).not.toContain('未配置上游')
  })

  it('共享条目那一条缺口写的是会话接线，不是已经取消的出舱确认', () => {
    // `functional-design.md` §13 把「出舱确认」这个状态取消了：交付落地即打开，
    // 没有「一个等待确认的条目」。拿一个不存在的状态描述缺口，等于把「还没做」
    // 和「已经决定不做」混成一件事，读者会去等一个不会来的确认。
    // 真实缺口是会话接线（`roadmap.md`）：起容器那一刻要重算一遍再挂。
    expect(limitations).toContain('会话接线还没做')
    expect(limitations).not.toContain('出舱确认')
    // 「真正的挂载」已经落地（契约 / 解析四道闸 / 真 docker 验证），
    // 再说它「仍在接入」就是把做完的事写在缺口里。
    expect(limitations).not.toContain('真正的挂载')
  })

  it('示意图源码画的是现形态，不是上一版', () => {
    // 图本身是二进制，断言不了；但它**是**从这份源码导出的，所以守源码就是守图。
    // 注释里会提到被删掉的东西（「停止全部在管理面板顶部」），所以先把注释和标签去掉，
    // 只对**画出来的字**下判断。
    const mock = readFileSync(join(docsDir, 'assets', 'tray-mock.html'), 'utf8')
    const drawn = mock
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<style>[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')

    expect(drawn).toContain('运行中 · 它拿不到你的密钥')
    expect(drawn).toContain('拖到这里 → 全部 agent 立刻可见')
    // 一次落后四处形态的旧图：胶囊、方块上的名字、dsh、footer。一处都不许回来。
    for (const gone of ['2 舱', 'dsh', '停止全部', '审计流水', '气闸', '凭据', 'Claude Code', 'Codex']) {
      expect(drawn, `示意图上还有旧形态：${gone}`).not.toContain(gone)
    }
    // 两个方块 × 两套主题：在跑的那个是实线描边 + 实心点，没跑的是虚线 + 空心圈。
    expect(mock.match(/class="agent claude running"/g)).toHaveLength(2)
    expect(mock.match(/class="agent idle"/g)).toHaveLength(2)
  })
})

describe('译制进度表', () => {
  const readme = readFileSync(join(sourceDir, 'README.md'), 'utf8')
  const rows = [...readme.matchAll(/^\|\s*`([\w/-]+)`\s*\|\s*(✅|⏳)\s*\|\s*(✅|⏳)\s*\|$/gm)].map(
    (match) => ({ slug: match[1] ?? '', zh: match[2], en: match[3] }),
  )

  it('表里每一页都在导航里，且中文状态与文件一致', () => {
    expect(rows.map((row) => row.slug).sort()).toEqual(pageSlugs)
    for (const row of rows) {
      expect(row.zh, `README 说 ${row.slug} 没有中文`).toBe('✅')
    }
  })

  it('标了已译的页面必须有英文文件，标了未译的必须没有', () => {
    for (const row of rows) {
      expect(existsSync(mdxPath('en', row.slug)), `${row.slug} 的英文状态与文件不符`).toBe(row.en === '✅')
    }
  })
})
