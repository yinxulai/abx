import { defineConfig, type ClarifyPlugin } from '@clarify-labs/cli'

// abx 使用手册的站点结构。
//
// 这里只声明「有哪些页、怎么分组」；每页的正文在 `source/<locale>/` 下的 MDX 里。
//
// 站点按**读者在不同阶段的问题**分五个 tab，而不是把页面堆进一个「使用指南」：
//
//   认识 abx（Sparkles）——「这东西跟我有关吗？」
//     一页讲完：它是什么、解决什么、明确不解决什么。
//   开始使用（Rocket）——「我能不能把它跑起来？」
//     安装与第一次运行（installation/first-run）→ 拖一个目录进去会发生什么。
//   舱里怎么工作（ShieldCheck）——「把活交出去之后，到底靠什么放心？」
//     凭据不出舱/生成且只读的配置 → 出口默认拒绝与审计 → 历史留在哪里。
//   Agent 与上游（Bot）——「它跑的是谁、请求最后去了哪？」
//     三个 agent 的清单 → 唯一的生产上游 OSW。
//   排查与限制（LifeBuoy）——「坏了怎么查、它到底不做哪些事？」
//     常见故障 → 明确的边界（local 后端不是沙箱、平台支持、未验证项）。
//
// 为什么不叫「使用指南」：整个站就是使用手册，用它当 tab 名是同义反复，读者点进去
// 还得自己找。按上面的问题切分后，tab 名本身就能让人判断「我要找的东西在不在
// 这里」。
//
// tab 与分组只服务于导航：同一件事只在一页里展开，跨页只写一句结论加链接。
//
// ── 站点边界：specs/ 不进站 ───────────────────────────────────────────────
// `apps/docs/specs/` 是**内部规格**（实现与评审用），不是使用者文档：
// 里面写着威胁模型的推导、尚未落地的取舍、明确没验证的项，以及只有维护者才关心
// 的模块边界。把它挂进公开站，读者会分不清「这是产品承诺」还是「这是内部备忘」，
// 而规格一旦为了对外好看而删改，就会失去它最该保留的东西。
//
// 所以这里只声明 `source/` 下的页面。**不要**把 `specs/` 加进 navigation，
// 也不要给它加一个「内部」tab —— `source/` 讲「怎么用」，`specs/` 讲「我们
// 决定怎么做」，两者读者、生命周期、发布方式都不同（见 ../README.md）。
//
// ── 多语言 ───────────────────────────────────────────────────────────────
// 中文是**主要维护语言**（default）：它占据根路径（`/inside/credentials`），是内容
// 的权威版本；英文挂在 `/en` 前缀下（`/en/inside/credentials`）。带语言前缀的链接
// （`/zh/...`、`/en/...`）永远稳定，默认语言另有无前缀的「裸路径」别名。
//
// 正文按 `source/zh/` 与 `source/en/` 分目录，两边的文件与 slug 一一对应。
// `missing: 'fallback'` 表示：英文缺哪一页，该页就自动回退到中文，而不是 404
// ——这让英文可以**增量补译**，站点任何时刻都不会出现断页，导航里也不会出现
// 点开就 404 的条目。
//
// 译制进度与「哪些页已有英文」只维护一处，见 ./source/README.md 的对照表；
// 本文件只负责导航，不重复记录进度。
//
// 导航、页脚、tab/分组/页标题都写成 { zh, en } 两语，随当前语言切换；站点级的
// `title` / `description` 仍是单值字符串（即默认语言中文），用于 SEO。
const zh = (zhText: string, enText: string) => ({ zh: zhText, en: enText })

// ── 触控目标 ────────────────────────────────────────────────────────────
// 主题自带的顶栏按钮是 36×36、页脚链接高 24px，在 390px 宽的视口下都低于 44×44 的
// 触控建议值（`pnpm --filter @abx/docs audit:ui` 会在窄屏把这条报成 🔴）。
//
// 站点配置里没有自定义 CSS 的入口，能用的只有 html 注入这一条：`html:transform`
// 钩子拿得到要插进 `<head>` 的 tag 列表，于是这里补一段只在窄屏生效的样式，
// 把可点区域撑到 44px——**只放大热区，不改图标尺寸**（图标仍按原样居中）。
//
// 代价是这些选择器是主题的内部类名（`.clarify-*`）。升级 @clarify-labs/cli 之后
// 要重跑 `audit:ui`：类名变了，这段样式会静默失效，而审计会照旧把 🔴 报出来。
const TOUCH_TARGET_CSS = `
/* 页内目录条目在宽屏下是 23px 高的行内链接，差 1px 够不到审计的 24px 桌面阈值；
   换成 flex 盒子给它一个下限，窄屏那段的 44px 也才有作用。 */
.clarify-anchor { display: inline-flex; align-items: center; min-height: 1.5rem; }

@media (max-width: 480px) {
  /* 顶栏图标按钮、页脚链接、正文操作（复制页面）、代码复制、页内目录。 */
  .clarify-mobile-navigation-button,
  .clarify-mobile-search-button,
  .clarify-language-switcher-button,
  .clarify-theme-toggle-button,
  .clarify-mobile-navbar-menu-button,
  .clarify-brand,
  .clarify-footer-link,
  .clarify-built-with,
  .clarify-content-actions-primary,
  .clarify-content-actions-trigger,
  .clarify-code-copy,
  .clarify-anchor { min-height: 44px; min-width: 44px; }

  /* 热区撑大之后顶栏变挤，站点名会被截成「abx …」。收间距比缩小字号或隐藏站点名都更不伤可读性。 */
  .clarify-header-main { gap: 0.5rem; }
  .clarify-header-left { gap: 0.5rem; }
  .clarify-header-actions { gap: 0.25rem; }
  .clarify-brand { gap: 0.25rem; }

  /* 这一段样式插在主题样式表**之前**，同权重会被主题盖掉；字号这类正面冲突的属性
     要靠多一层选择器提权重（min-width/min-height 是主题没设过的属性，不冲突）。 */
  .clarify-header .clarify-brand-title { font-size: 0.8125rem; }
}`

const touchTargets: ClarifyPlugin = {
  name: 'abx:touch-targets',
  hooks: {
    'html:transform': (input) => ({
      ...input,
      tags: [
        ...input.tags,
        { tag: 'style', attrs: { 'data-abx': 'touch-targets' }, children: TOUCH_TARGET_CSS },
      ],
    }),
  },
}

export default defineConfig({
  plugins: [touchTargets],
  title: 'abx 使用手册',
  description: '给 AI coding agent 用的隔离舱：凭据留在舱外，出口默认拒绝，所有进出留痕。',
  // 部署地址尚未确定，因此先不写 siteUrl（它只影响 sitemap / canonical）。
  // 定下域名后补在这里，并同步 wrangler.toml 的 routes。
  logo: '/logo.svg',
  // **缺省值**，不是站上实际生效的那一条：模板 `index.html` 自己声明了 rel=icon，
  // 而 clarify 见到模板已经声明就不再注入（`createHtmlShellPlugin` 里的 `REL_ICON_RE`）。
  // 两处指的是同一个文件（都由 `pnpm icons` 产出）；改图标路径要**两处一起改**。
  favicon: '/favicon.svg',
  theme: {
    preset: 'default',
    tokens: {
      colors: {
        // 与 apps/www 同一处冷色点缀（气闸的冰蓝），只用于链接、选中与焦点。
        // 浅色下用深一档保证正文链接的对比度，暗色下用亮一档。
        primary: { light: '#0369a1', dark: '#7dd3fc' },
        accent: { light: '#0e7490', dark: '#38bdf8' },
      },
    },
  },
  // 中文为默认语言（根路径 + 权威版本），英文挂 /en 前缀，缺译自动回退中文。
  locales: {
    default: 'zh',
    missing: 'fallback',
    locales: [
      { code: 'zh', label: '中文' },
      { code: 'en', label: 'English' },
    ],
  },
  navigation: {
    menus: [
      { label: zh('开始使用', 'Get started'), href: '/getting-started/installation' },
      { label: zh('限制', 'Limitations'), href: '/limits/limitations' },
    ],
    tabs: [
      {
        tab: zh('认识 abx', 'Meet abx'),
        icon: 'Sparkles',
        pages: [
          {
            group: zh('先看这里', 'Start here'),
            icon: 'Sparkles',
            pages: [{ page: 'index', title: zh('abx 是什么', 'What abx is'), icon: 'Sparkles' }],
          },
        ],
      },
      {
        tab: zh('开始使用', 'Get started'),
        icon: 'Rocket',
        pages: [
          {
            group: zh('跑起来', 'Get it running'),
            icon: 'Rocket',
            pages: [
              { page: 'getting-started/installation', title: zh('安装与第一次运行', 'Install & first run'), icon: 'Download' },
              { page: 'getting-started/first-run', title: zh('拖进去之后会发生什么', 'What happens after you drop'), icon: 'Flag' },
            ],
          },
        ],
      },
      {
        tab: zh('舱里怎么工作', 'Inside the cell'),
        icon: 'ShieldCheck',
        pages: [
          {
            group: zh('凭据与配置', 'Credentials & config'),
            icon: 'KeyRound',
            pages: [
              { page: 'inside/credentials', title: zh('凭据不出舱', 'Credentials never enter'), icon: 'KeyRound' },
              { page: 'inside/config', title: zh('配置是生成的，只读', 'Generated, read-only config'), icon: 'FileCog' },
            ],
          },
          {
            group: zh('出口与记录', 'Egress & records'),
            icon: 'Activity',
            pages: [{ page: 'inside/egress', title: zh('出口默认拒绝，且留痕', 'Deny by default, always logged'), icon: 'Activity' }],
          },
          {
            group: zh('历史', 'History'),
            icon: 'HardDrive',
            pages: [{ page: 'inside/history', title: zh('历史留在哪里', 'Where history lives'), icon: 'History' }],
          },
        ],
      },
      {
        tab: zh('Agent 与上游', 'Agents & upstreams'),
        icon: 'Bot',
        pages: [
          {
            group: zh('三个 agent', 'The three agents'),
            icon: 'Bot',
            pages: [{ page: 'agents/available', title: zh('claude / codex / dsh', 'claude / codex / dsh'), icon: 'Bot' }],
          },
          {
            group: zh('上游', 'Upstreams'),
            icon: 'Network',
            pages: [{ page: 'agents/upstream', title: zh('唯一的生产上游：OSW', 'The one production upstream: OSW'), icon: 'Network' }],
          },
        ],
      },
      {
        tab: zh('排查与限制', 'Troubleshoot & limits'),
        icon: 'LifeBuoy',
        pages: [
          {
            group: zh('排查', 'Troubleshoot'),
            icon: 'LifeBuoy',
            pages: [{ page: 'limits/troubleshooting', title: zh('常见故障', 'Troubleshooting'), icon: 'LifeBuoy' }],
          },
          {
            group: zh('边界', 'Limits'),
            icon: 'CircleSlash',
            pages: [{ page: 'limits/limitations', title: zh('明确不做的边界', 'Explicit limits'), icon: 'CircleSlash' }],
          },
        ],
      },
    ],
  },
  footer: {
    copyright: zh('© 2026 abx. 给 AI coding agent 用的隔离舱。', '© 2026 abx. An isolation cell for AI coding agents.'),
    links: [
      { label: zh('abx 是什么', 'What abx is'), href: '/' },
      { label: zh('开始使用', 'Get started'), href: '/getting-started/installation' },
      { label: zh('限制', 'Limitations'), href: '/limits/limitations' },
    ],
  },
})
