#!/usr/bin/env node
/**
 * 站点跑起来之后的本地核对：对每一页做一次程序化的 UI 审计
 * （对比度、字号档位、触控目标、横向溢出、文字截断）。
 *
 * 为什么要有这一步：MDX 里的表格、代码块、卡片是主题渲染的，单测和 typecheck
 * 都看不见它们。改一行文案可能把标题挤换行，加一列可能让窄屏横向溢出——这些只能
 * 在真浏览器里量。
 *
 * 审计实现不在这里重写：本机已有 `design-review-loop` 技能里的零依赖审计脚本
 * （Chrome DevTools Protocol），本脚本只负责「列出所有页面 × 两个视口」并汇总退出码。
 * 路径可用 `ABX_AUDIT_BIN` 覆盖；找不到就明确报错，而不是静默跳过。
 *
 * 用法:
 *   node scripts/audit-ui.mjs [baseUrl] [--out <dir>]
 *   baseUrl 默认 http://127.0.0.1:5199（`pnpm dev` 的默认端口）
 *
 * 退出码: 0 = 没有 🔴；1 = 有 🔴；2 = 运行错误（比如站点没起来、审计脚本找不到）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const baseUrl = (args.find((arg) => !arg.startsWith('--')) ?? 'http://127.0.0.1:5199').replace(/\/$/, '')
const outIndex = args.indexOf('--out')
const outDir = resolve(docsDir, outIndex >= 0 ? (args[outIndex + 1] ?? '.state/audit') : '.state/audit')

const auditBin =
  process.env.ABX_AUDIT_BIN ??
  join(homedir(), '.openclaw/workspace/skills/design-review-loop/scripts/audit.mjs')

if (!existsSync(auditBin)) {
  console.error(`找不到审计脚本: ${auditBin}\n用 ABX_AUDIT_BIN=<path> 指一个，或确认本机的 design-review-loop 技能还在。`)
  process.exit(2)
}

// 页面清单从 clarify.ts 里读：审计覆盖的就是导航里真实存在的那些页。
const clarifyConfig = readFileSync(join(docsDir, 'clarify.ts'), 'utf8')
const slugs = [...new Set([...clarifyConfig.matchAll(/page:\s*'([^']+)'/g)].map((match) => match[1]))]
if (slugs.length === 0) {
  console.error('没有从 clarify.ts 里读到任何 page，导航结构可能换了写法。')
  process.exit(2)
}
const routes = slugs.map((slug) => (slug === 'index' ? '/' : `/${slug}`))

const viewports = ['1440x900', '390x844']

// 审计脚本对「触控目标」只有一个统一阈值，它不知道 WCAG 2.5.8 给**行内链接**留的例外：
// 正文段落里的链接只要行高正常就不该被撑到 44×44，否则相邻行的文字会被链接的热区盖住，
// 那才是真的点错。这类链接在报告里的特征很清楚——`<a>` 上没有任何 class 或 id
// （主题给按钮和导航项都挂了 `clarify-*` 类名）。
//
// 例外**只针对这一种元素**：带类名的控件（顶栏按钮、页脚链接、正文操作、代码复制、
// 页内目录）一个都不放过，`clarify.ts` 里的窄屏样式负责把它们撑到 44px。
const isInlineProseLink = (item) => item.el === 'a'

const dropInlineLinkExceptions = (findings) =>
  findings
    .map((finding) => {
      if (finding.type !== 'tap-target') return finding
      const items = (finding.detail?.items ?? []).filter((item) => !isInlineProseLink(item))
      if (items.length === 0) return null
      return { ...finding, msg: `${items.length} 个交互元素小于触控目标阈值`, detail: { ...finding.detail, items } }
    })
    .filter((finding) => finding !== null)

const waitForServer = async (url) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'text/html' } })
      if (response.ok) return
    } catch {
      // 还没起来，继续等
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`站点没有响应: ${url}（先跑 pnpm dev）`)
}

mkdirSync(outDir, { recursive: true })

await waitForServer(`${baseUrl}/`)

let fatal = 0
const summary = []
const flaky = []

/** 一条发现的指纹：类型 + 涉及的元素。用来判断两次审计是不是报了同一件事。 */
const fingerprint = (finding) =>
  [
    finding.type,
    ...(finding.detail?.items ?? []).map((item) => `${item.el}|${item.text}|${item.size}`),
    ...(finding.detail?.culprits ?? []).map((item) => `${item.el}|${item.w}`),
  ].join('~')

const runAudit = (route, viewport, reportPath) => {
  // 审计脚本用退出码报告结果（1 = 有 🔴），所以这里不看退出码，只读它写的报告；
  // 只有连报告都没写出来（退出码 2：运行错误）才算这次核对失败。
  const result = spawnSync(
    process.execPath,
    [auditBin, `${baseUrl}${route}`, '--viewport', viewport, '--json', '--out', reportPath],
    { encoding: 'utf8' },
  )
  if (result.status === 2 || !existsSync(reportPath)) {
    console.error(`审计脚本没能跑完 ${route} @ ${viewport}`)
    console.error(result.stdout ?? '')
    console.error(result.stderr ?? '')
    process.exit(2)
  }
  return dropInlineLinkExceptions(JSON.parse(readFileSync(reportPath, 'utf8')).issues?.fatal ?? [])
}

for (const route of routes) {
  for (const viewport of viewports) {
    const name = `${route === '/' ? 'index' : route.slice(1).replaceAll('/', '-')}-${viewport}`
    const reportPath = join(outDir, `${name}.json`)
    let reds = runAudit(route, viewport, reportPath)

    // headless Chrome 偶尔会在页面还没渲染完时取样（例如报「缺 viewport meta」，而每一页
    // 的 HTML 里都有）。所以出现 🔴 时**再量一次**，只把两次都出现的算数：真问题会复现，
    // 取样噪声不会。复现不了的记进 summary 的 flaky 里，不静默丢掉。
    if (reds.length > 0) {
      const first = new Set(reds.map(fingerprint))
      const second = runAudit(route, viewport, reportPath)
      const secondKeys = new Set(second.map(fingerprint))
      for (const finding of reds) {
        if (!secondKeys.has(fingerprint(finding))) {
          flaky.push({ route, viewport, type: finding.type, msg: finding.msg })
        }
      }
      reds = second.filter((finding) => first.has(fingerprint(finding)))
    }

    const yellows = dropInlineLinkExceptions(
      JSON.parse(readFileSync(reportPath, 'utf8')).issues?.important ?? [],
    )
    fatal += reds.length
    summary.push({ route, viewport, fatal: reds.length, important: yellows.length })
    if (reds.length > 0) {
      console.log(`🔴 ${route} @ ${viewport}`)
      for (const issue of reds) console.log(`   ${issue.type}: ${issue.msg}`)
    } else {
      console.log(`✓ ${route} @ ${viewport}${yellows.length > 0 ? `（🟡 ${yellows.length}）` : ''}`)
    }
  }
}

writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ summary, flaky }, null, 2)}\n`)
for (const item of flaky) {
  console.log(`（跳过）${item.route} @ ${item.viewport} 只出现一次：${item.type} ${item.msg}`)
}
console.log(`\n${summary.length} 次审计，🔴 ${fatal} 条（复现两次才算）。报告在 ${outDir}`)
process.exit(fatal > 0 ? 1 : 0)
