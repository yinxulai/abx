import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * 双语策略（与 osw 的 `apps/www` 同一套）：
 *
 * - **中文是主要维护语言，也是兜底语言**。中文不建资源表，而是写在
 *   `t(key, '中文文案')` 的第二个参数里，就写在用到它的那个组件里 ——
 *   改文案和改代码在同一个文件里发生。
 * - **英文是增量补的**。key 出现在 `en` 表里就有英文，没出现就回退到中文。
 *   所以漏译一句的结果是「这一句还是中文」，不是空白、不是 key、更不是 404。
 * - 站点是单页，没有路由，因此不存在 `/en` 这样的路径，也就没有「英文页 404」
 *   这回事：语言只是页面上的一个开关，切完还是这一页。
 *
 * 新增文案的顺序：先在组件里写中文兜底，跑 `pnpm test`，`i18n.test.ts` 会列出
 * 缺英文的 key；再决定要不要补。
 */

/** 站点支持的语言。 */
export type Lang = 'en' | 'zh'

export const LANG_STORAGE_KEY = 'abx-language'

export const LANGS: readonly { id: Lang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
]

/** 兜底语言固定为中文：英文缺 key 时回落到组件里内联的中文。 */
export const FALLBACK_LANG: Lang = 'zh'

/**
 * URL 上钉住语言的参数：`?lang=en`。与 `?theme=` 同一套用法，理由也一样 ——
 * 截图、评审、分享一条固定语言的链接时，语言不能由浏览器的 `navigator.language`
 * 决定（无头浏览器报的是 `en-US`，看到的就是英文页，而那并不是主要维护语言）。
 */
export const LANG_QUERY_KEY = 'lang'

/**
 * 英文译文表，key 与各组件的 `t()` 第一个参数一一对应。
 *
 * 这里只放英文：中文是「代码里的原文」，英文是「翻译」。两层分开，
 * 就不存在「中文表改了、组件里的原文忘了改」这种双份真相。
 */
export const en = {
  app: {
    skipToContent: 'Skip to content',
  },
  nav: {
    label: 'Page sections',
    home: 'Back to the top of the page',
    model: 'Credentials',
    agents: 'Agents',
    start: 'Get started',
    boundaries: 'Boundaries',
    faq: 'FAQ',
    download: 'Download',
    themeLight: 'Switch to light theme',
    themeDark: 'Switch to dark theme',
    language: 'Language',
    status: 'macOS · in progress',
  },
  hero: {
    badge: 'AIRLOCK BOX · macOS tray app',
    title: 'An airlock for your AI coding agent',
    lead: 'Hand a repository and a few files into a disposable cell and let the agent work inside it the way it would on your machine. It cannot reach your keys, cannot leave the allowlist, and cannot delete your machine.',
    sub: 'Models and keys stay outside, in OSW. Inside the cell there is one address and one placeholder — ',
    subAccent: 'nothing worth leaking.',
    primary: 'See what is inside',
    secondary: 'How it works',
    highlightKeys: 'No key enters the cell',
    highlightEgress: 'Egress denied by default',
    highlightAudit: 'Everything audited',
  },
  tray: {
    status: 'Airlock running · every credential stays outside',
    cells: '2 cells',
    shared: 'Shared with every agent',
    sharedCount: '2 items',
    readOnly: 'read-only',
    dropHint: 'Drop a file here → every agent sees it at once',
    audit: 'Audit log…',
    stopAll: 'Stop all',
    quit: 'Quit',
    caption: 'Panel mock-up · drawn from the product spec; the desktop shell is still in progress',
  },
  model: {
    eyebrow: 'Credentials',
    title: 'Keys do not enter the cell, and that is not a setting',
    lead: 'abx does not rely on hiding your keys well. It relies on the cell having no real key to begin with. All four statements below have to hold — drop one and the conclusion goes with it.',
    body1:
      'Models and keys are configured on the host, in OSW, which has already collected your channels behind a single local address. abx copies none of that configuration and carries no key into the cell.',
    body2:
      'Everything the agent inside sees is on the right: one custom provider, one baseUrl, one placeholder token that the airlock replaces unconditionally. No provider list, no model list, no account, no second key.',
    quote: 'What is hidden gets found; ',
    quoteAccent: 'what does not exist cannot be.',
    whoTitle: 'Who holds what',
    who: 'Who',
    holds: 'Holds',
    tableCaption: 'What OSW, the airlock and the agent inside the cell each hold',
    questionsTitle: 'Three questions this always gets',
    footnote:
      'The airlock is the front door of the cell and OSW is the control room behind it: the cell only ever sees one address, pointing at the airlock, which hands the request to OSW — OSW itself needs no changes.',
    sampleTitle: 'Everything the agent inside can see',
    sampleBadge: 'mock-up',
    sampleComment: '// replaced unconditionally',
    principle: {
      host: {
        title: 'Keys stay on the host, outside the cell',
        body: 'Providers, keys and model routing are configured in OSW on the host. abx copies none of that and writes no credential into the cell — the environment variables inside contain no real key, and a test guards exactly that.',
      },
      placeholder: {
        title: 'Inside the cell there is only a placeholder',
        body: 'The apiKey the agent holds is a fake token that the airlock swaps out unconditionally. Printing it, committing it or pasting it to someone has no consequence whatsoever.',
      },
      egress: {
        title: 'Egress is denied by default',
        body: 'Traffic leaves only to domains on the allowlist. Anything not listed is blocked and recorded as a denial — the default is already the strictest setting, so there is nothing for you to tighten.',
      },
      audit: {
        title: 'Every request in and out is recorded',
        body: 'One line per forwarded request: time, cell, target domain, allowed or denied, status code, duration. The key column only ever says injected or not injected — never the value.',
      },
    },
    question: {
      baseUrl: {
        q: 'The baseUrl points at the airlock — is that not the same as handing over the key?',
        a: 'The airlock authenticates the cell token, not that placeholder. The cell token is issued per session and dies with the cell — replay it and you get a 401.',
      },
      sibling: {
        q: 'Can the agent just read the credential file next door?',
        a: 'No. Only the single config file abx generates is mounted. A credential file in the same directory (.credentials.json, auth.json and friends) is blocked by its own rule, and the error says so in those words. The file does not exist inside the cell at all — it is not a permissions problem.',
      },
      audit: {
        q: 'Can a key leak into the audit log?',
        a: 'No: that column only says injected or not injected. The key exists in the airlock process memory and is attached at the moment of forwarding; nothing about it is persisted.',
      },
    },
  },
  agents: {
    eyebrow: 'Agents',
    title: 'Three agents, one manifest each',
    lead: 'abx does not hard-code its agents: one agent is one manifest entry. The three cards below read that manifest, not a copy of it.',
    statusStable: 'verified',
    statusUnconfirmed: 'unverified',
    fieldCommand: 'Command inside the cell',
    fieldUpstream: 'Default upstream',
    fieldEnv: 'Environment inside the cell',
    fieldPlaceholder: 'Placeholder in the cell',
    fieldCellToken: 'How the cell token travels',
    cellTokenHeader: 'request header (never in a URL or a log line)',
    cellTokenPath: 'URL path prefix (this agent cannot add custom headers)',
    fieldConfig: 'Files written into the cell',
    configGenerated: 'written by abx, mounted read-only',
    configRegistered: 'registered only — not written, not mounted',
    fieldHistory: 'Where history goes',
    fieldImage: 'Image',
    imageMissing: 'not specified per agent yet',
    none: 'not declared in the manifest',
    caveatTitle: 'Three "not yet" answers on this page',
    caveatImage:
      'Image: the manifest does not name one per agent yet, so this reads "not specified" instead of quietly borrowing a global default. It fills itself in once the manifest declares one.',
    caveatHistory:
      'History: these are the directories each agent writes its history and sessions into. Per-cell persistence is still being built — until it lands, these directories do not survive the container.',
    caveatStatus:
      'Verification: the entry marked "unverified" has no authoritative source for its command name or config field names yet. Check it yourself before relying on it.',
    upstreamTitle: 'What the upstream column means',
    upstreamBody:
      'It is the default upstream in that manifest entry, not the whole set you can reach. What actually decides where a request goes is the channel configuration in OSW, outside the cell: keys, routing and failover all live there, and the cell neither sees nor needs to know about them.',
  },
  boundaries: {
    eyebrow: 'Boundaries',
    title: 'Safe by default, not by configuration',
    lead: 'The allowlist, the read-only mounts and the audit log are defaults, not settings. A sandbox that starts wide open and waits for you to tighten it is, in real use, no sandbox at all.',
    item: {
      egress: {
        title: 'Egress is denied by default',
        body: 'Traffic leaves only to domains on the allowlist. Anything not listed is blocked and recorded as a denial — the default is already the strictest setting, so there is nothing for you to tighten.',
      },
      shared: {
        title: 'Shared items are read-only',
        body: 'Everything you hand in is mounted read-only. The agent can read it and cannot change it; when it needs to produce something, that goes into the outbox of that one cell.',
      },
      audit: {
        title: 'Every request is recorded',
        body: 'One line per outbound request: time, cell, target domain, allowed or denied, status code, duration. The key column only ever says injected or not injected — never the value.',
      },
      disposable: {
        title: 'Cells are disposable',
        body: 'A cell is destroyed when it exits. No login item, no background process, and the only changes that survive are in the task directory and the outbox.',
      },
    },
    nonPromiseTitle: 'What this explicitly does not promise',
    nonPromise: {
      kernel:
        'It does not promise to stop a kernel-level escape — the kernel is shared; a container is not a virtual machine.',
      selfInflicted:
        'It does not promise to stop you dragging credentials into the shared area yourself — the gate stops the agent getting them, not you handing them over.',
      anonymity: 'It does not promise anonymity on the network — the outbound IP is still yours.',
      adversarial:
        'It does not promise it has survived an adversarial attack — the evidence so far is that it behaves correctly in normal use, and nobody has yet tried to bypass the allowlist or forge a cell token.',
      taskDir:
        'It does not promise the task directory can be rolled back — it is a real writable directory, and whatever the agent deletes in there does not come back.',
    },
    platformTitle: 'How far each platform is supported',
    platformCaption: 'Support level and reason for each of the three desktop platforms',
    platformColumn: 'Platform',
    supportColumn: 'Support',
    whyColumn: 'Why',
    platform: {
      macos: {
        support: 'The V1 target',
        detail:
          'The tray, drag and drop, and App Sandbox are all macOS ideas, so V1 is macOS only. It is in progress, and has not yet been verified on real macOS hardware.',
      },
      linux: {
        support: 'Development only',
        detail:
          'Used only to exercise the logic through the local backend. It isolates nothing: the product labels it "not a sandbox, not for demos". There is no Linux desktop build.',
      },
      windows: {
        support: 'Not planned',
        detail:
          'No schedule. The backend set aside in the design is Windows Sandbox, but V1 explicitly excludes a Windows desktop build.',
      },
    },
    unsuitableTitle: 'When this does not apply',
    unsuitable: {
      guiApp:
        'The thing you want to test needs a window and menu clicks — there is no graphical interface inside a cell.',
      kernelWork:
        'You need kernel modules, system settings, or harder isolation than a container — use a virtual machine.',
      dockerInDocker:
        'The task itself starts containers — there is no docker socket inside a cell, deliberately.',
      wholeMachine:
        'You want the agent to read any path on your machine — it only sees the directories you hand in.',
      longLived:
        'You want a long-lived environment that keeps all its state across sessions — cells are disposable.',
    },
  },
  start: {
    eyebrow: 'Get started',
    title: 'Three steps to hand the work over',
    lead: 'No command line, no configuration file, and no key to type in. The tray is the whole entrance.',
    step: {
      install: {
        title: 'Install it',
        body: 'There is no installer yet. Once there is, it is a .dmg you drag into Applications. The signature is ad-hoc and there is no notarisation, so the first launch is stopped by Gatekeeper and you let it through in Privacy & Security — that step goes away once there is a real signature.',
      },
      firstRun: {
        title: 'Open it for the first time',
        body: 'An abx icon appears in the menu bar, and nothing in the Dock. Open the panel: the first line already says how many cells are running and where the credentials live. No setup wizard, no key to paste — the keys are in OSW, outside the cell, so there is nowhere here to put one.',
      },
      drop: {
        title: 'Drag a directory in',
        body: 'Drop it on the menu bar icon, or on the dashed area in the panel. It becomes a shared item: the agent inside can read it at once, read-only. It works inside that directory, writes what it produces into the outbox of its own cell, and one click puts that in Finder.',
      },
    },
    note: 'Drag and drop uses the native macOS menu bar, which is why the first version is macOS only. When you want things to stop, "Stop all" stops cells: the files in the shared area and the outbox stay where they are, and removing a shared item only unmounts it — it never deletes your original.',
  },
  footer: {
    line: 'An airlock for your AI coding agent. The first version is macOS only.',
  },
} as const

const isLang = (value: string | null | undefined): value is Lang => value === 'en' || value === 'zh'

/**
 * 首次进入的语言，优先级：URL 参数 > 上次选择 > 浏览器语言 > 兜底（中文）。
 *
 * 与 `theme.ts` 的 `initialTheme` 是同一套顺序 —— 首帧语言由 `index.html` 的
 * 内联脚本按这里的规则先写好，两边不一致就会「先中文后英文」闪一下。
 */
export function detectLang(): Lang {
  const pinned = readPinnedLang()
  if (pinned) return pinned

  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    // 隐私模式等场景可能禁止访问；继续按浏览器语言判断。
  }

  const preferred = typeof navigator === 'undefined' ? '' : navigator.language
  return preferred.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 读 `?lang=`。不是合法语言就当没写，而不是把页面切到空语言。 */
function readPinnedLang(): Lang | null {
  if (typeof window === 'undefined') return null
  try {
    const value = new URLSearchParams(window.location.search).get(LANG_QUERY_KEY)
    return isLang(value) ? value : null
  } catch {
    // 拿不到 location（非浏览器环境）时按「没钉」处理。
    return null
  }
}

/** 当前语言写回 URL：切过语言之后复制地址，打开的还是同一幅界面。 */
export function syncLangUrl(lang: Lang): void {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  url.searchParams.set(LANG_QUERY_KEY, lang)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

i18n.on('languageChanged', (language) => {
  if (!isLang(language)) return

  try {
    localStorage.setItem(LANG_STORAGE_KEY, language)
  } catch {
    // 无法持久化不影响当前页面的语言切换。
  }
  syncLangUrl(language)
})

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: detectLang(),
  fallbackLng: FALLBACK_LANG,
  // 纯前端渲染且文案自带中文兜底，插值无需转义。
  interpolation: { escapeValue: false },
  // 资源内联、初始化同步完成，无需 Suspense 边界。
  react: { useSuspense: false },
})

export default i18n
