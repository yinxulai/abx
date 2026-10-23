import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import i18n, { en, FALLBACK_LANG } from './i18n'

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))

function collectSourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry)
    if (statSync(fullPath).isDirectory()) {
      found.push(...collectSourceFiles(fullPath))
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(fullPath)
  }
  return found
}

function flattenKeys(value: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') keys.push(fullKey)
    else if (child && typeof child === 'object') {
      keys.push(...flattenKeys(child as Record<string, unknown>, fullKey))
    }
  }
  return keys
}

/**
 * 组件里 `t('a.b', '中文')` 的静态 key 全集。
 *
 * 数据表驱动的文案（例如 FAQ 的条目）取不到字面量，所以它们的 key 单独列在
 * `DYNAMIC_TRANSLATION_KEYS` 里。两张表合起来就是「页面上会出现的每一个 key」。
 */
function collectStaticTranslationKeys(): Set<string> {
  const keys = new Set<string>()

  for (const file of collectSourceFiles(SOURCE_DIRECTORY)) {
    const source = readFileSync(file, 'utf8')
    const literalPattern = /\bt\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1\s*[,)]/g

    for (const match of source.matchAll(literalPattern)) {
      const [, , value] = match
      if (value && !value.includes('${')) keys.add(value)
    }
  }

  return keys
}

/** 数据表里的文案 key。值集变化时，这个测试会立刻暴露缺英文的那一条。 */
const DYNAMIC_TRANSLATION_KEYS = [
  'nav.model',
  'nav.agents',
  'nav.start',
  'nav.boundaries',
  'nav.faq',
  'nav.download',
  'model.principle.host.title',
  'model.principle.host.body',
  'model.principle.placeholder.title',
  'model.principle.placeholder.body',
  'model.principle.egress.title',
  'model.principle.egress.body',
  'model.principle.audit.title',
  'model.principle.audit.body',
  'model.question.baseUrl.q',
  'model.question.baseUrl.a',
  'model.question.sibling.q',
  'model.question.sibling.a',
  'model.question.audit.q',
  'model.question.audit.a',
  'boundaries.item.egress.title',
  'boundaries.item.egress.body',
  'boundaries.item.shared.title',
  'boundaries.item.shared.body',
  'boundaries.item.audit.title',
  'boundaries.item.audit.body',
  'boundaries.item.disposable.title',
  'boundaries.item.disposable.body',
  'boundaries.nonPromise.kernel',
  'boundaries.nonPromise.selfInflicted',
  'boundaries.nonPromise.anonymity',
  'boundaries.nonPromise.adversarial',
  'boundaries.nonPromise.taskDir',
  'boundaries.platform.macos.support',
  'boundaries.platform.macos.detail',
  'boundaries.platform.linux.support',
  'boundaries.platform.linux.detail',
  'boundaries.platform.windows.support',
  'boundaries.platform.windows.detail',
  'boundaries.unsuitable.guiApp',
  'boundaries.unsuitable.kernelWork',
  'boundaries.unsuitable.dockerInDocker',
  'boundaries.unsuitable.wholeMachine',
  'boundaries.unsuitable.longLived',
  'start.step.install.title',
  'start.step.install.body',
  'start.step.firstRun.title',
  'start.step.firstRun.body',
  'start.step.drop.title',
  'start.step.drop.body',
  'faq.item.vsLocal.q',
  'faq.item.vsLocal.a',
  'faq.item.keysReally.q',
  'faq.item.keysReally.a',
  'faq.item.isSandbox.q',
  'faq.item.isSandbox.a',
  'faq.item.macOnly.q',
  'faq.item.macOnly.a',
  'faq.item.oswChange.q',
  'faq.item.oswChange.a',
  'faq.item.allowlist.q',
  'faq.item.allowlist.a',
  'faq.item.available.q',
  'faq.item.available.a',
  'faq.item.account.q',
  'faq.item.account.a',
  'changelog.release.first.status',
  'changelog.release.first.title',
  'changelog.release.first.item.tray',
  'changelog.release.first.item.airlock',
  'changelog.release.first.item.agents',
  'changelog.release.first.item.cells',
  'changelog.release.first.caveat',
] as const

describe('官网 i18n', () => {
  it('keeps Chinese as the fallback language', () => {
    expect(FALLBACK_LANG).toBe('zh')
    expect(i18n.options.fallbackLng).toEqual(['zh'])
  })

  it('falls back to the Chinese text passed at the call site', () => {
    // 英文表里没有这个 key —— 这正是「英文缺一句」时的真实路径：
    // 页面显示调用点写的中文，而不是 key、空白或抛错。
    expect(i18n.t('hero.notTranslatedYet', { defaultValue: '还没翻的一句' })).toBe('还没翻的一句')
  })

  it('serves the English table for keys that exist in it', () => {
    expect(i18n.getResource('en', 'translation', 'nav.agents')).toBe(en.nav.agents)
  })

  it('has an English string for every static t() key in the source', () => {
    const available = new Set(flattenKeys(en))
    const missing = [...collectStaticTranslationKeys()].filter(key => !available.has(key))
    expect(missing).toEqual([])
  })

  it('has an English string for every dynamic key group', () => {
    const available = new Set(flattenKeys(en))
    expect(DYNAMIC_TRANSLATION_KEYS.filter(key => !available.has(key))).toEqual([])
  })
})
