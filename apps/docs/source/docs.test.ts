/**
 * 文档站的自检。
 *
 * 这一组测试守着三件容易悄悄坏掉的事：
 *
 * 1. **导航与文件对得上**：`clarify.ts` 里声明的每一页都有中文 MDX，反过来中文 MDX
 *    也都出现在导航里；站内链接都能落到某个真实页面。少一个文件、链接写错一个 slug，
 *    站点不会报错，只会安静地 404——所以必须由测试来喊。
 * 2. **文档数据不跟代码漂移**：agent 的名字、命令、配置落点、镜像默认值只能有两处来源
 *    ——清单（`packages/contracts/source/agents.ts`）与 schema 默认值。页面里的
 *    Markdown 数据（路径、镜像名）在这里逐条对照清单校验。
 * 3. **不该进使用者文档的东西不进**：明文凭据、内部术语（`cellId` / `lease`）。
 *
 * 译制进度表也在 `source/README.md`，本文件对照它检查英文文件是否存在，
 * 免得表里写「已译」而文件没建。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_DEFINITIONS, type AgentDefinition } from '@abx/contracts/agents'
import { describe, expect, it } from 'vitest'

import clarifyConfig from '../clarify'
import {
  AGENT_COUNT,
  AGENT_DOCS,
  IMAGES_DECLARED,
  SESSION_IMAGE_FALLBACK,
  STATE_PATHS_DECLARED,
} from './data/agents'

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
  // abx 自己在宿主上的持久化目录。
  '~/.abx',
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

  it('镜像与历史目录的状态如实反映清单', () => {
    AGENT_DEFINITIONS.forEach((definition, index) => {
      const raw = definition as AgentDefinition & {
        readonly image?: string
        readonly statePaths?: readonly string[]
      }
      const doc = AGENT_DOCS[index]
      expect(doc?.image).toBe(raw.image ?? null)
      expect(doc?.statePaths).toEqual(raw.statePaths ?? [])
      // 清单还没有 per-agent 镜像时，文档只能说回退镜像；有了就必须改文档。
      expect(IMAGES_DECLARED).toBe(AGENT_DEFINITIONS.every((agent) => 'image' in agent))
      expect(STATE_PATHS_DECLARED).toBe(AGENT_DEFINITIONS.every((agent) => 'statePaths' in agent))
    })
  })

  it('默认镜像取自 schema 默认值', () => {
    expect(SESSION_IMAGE_FALLBACK).toBe('node:22-slim')
    for (const file of mdxFiles) {
      // 镜像名只能经 `SESSION_IMAGE_FALLBACK` 注入，不许手抄常量。
      expect(readFileSync(file.path, 'utf8'), `${file.path} 手抄了镜像名`).not.toContain('node:22-slim')
    }
    for (const slug of ['limits/troubleshooting', 'limits/limitations']) {
      expect(readMdx('zh', slug)).toContain('SESSION_IMAGE_FALLBACK')
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
