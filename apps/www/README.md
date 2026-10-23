# @abx/www

产品官网：一页落地页，讲清「abx 是什么、为什么安全」。Vite + React + Tailwind v4
（CSS-first，没有 `tailwind.config.js`），纯静态产物。

**现状**：单页、双语（中文是原文，英文增量补）、八个区块，见下表。
没有路由、没有部署配置 —— 等有实际需要再加。

**分工**：官网回答「**为什么该用它**」，`apps/docs` 回答「**怎么用**」。
官网不给步骤，只给结论加指路；写这一页的规矩在
[`../../docs/specs/product/www.md`](../../docs/specs/product/www.md)。

## 结构

| 路径 | 职责 |
| --- | --- |
| `source/index.css` | 设计令牌（`@theme` + 浅色覆盖）、基础层、`off-screen` / `bg-grid` 工具类。改配色只改这一处 |
| `source/i18n.ts` | i18next 初始化、英文表、`detectLang` / `syncLangUrl` |
| `source/theme.ts` | 主题的首帧判定、写回根节点、写回 URL |
| `source/entry-server.tsx` | 构建期的预渲染入口：用 `react-dom/server` 渲染整页（只在 Node 里跑） |
| `source/mount.tsx` | 客户端挂载：状态一致时 `hydrateRoot`，否则 `createRoot` |
| `source/hydration.ts` | 水合判据（预渲染状态 = 中文 + 深色） |
| `scripts/prerender.mjs` | 把 SSR 结果注入 `output/index.html`，随后删掉 SSR 产物 |
| `vite.config.ssr.ts` | SSR 构建：产物写 `output-ssr/`，与客户端产物分开 |
| `source/agents.ts` | 只做一件事：把 `@abx/contracts/agents` 的清单转成页面行 |
| `source/App.tsx` | 只负责背景层与区块顺序，不写文案 |
| `source/components/*` | 一节一个文件，文案跟着所属区块走（中文写在 `t(key, '中文')` 里） |
| `source/components/airlock-mark.tsx` | 品牌标记（装饰，`aria-hidden`）；其余图标一律 `lucide-react` |
| `index.html` | 标题、描述、`theme-color`，以及首帧写 `lang` / `data-theme` 的内联脚本 |
| `*.test.tsx` / `*.test.ts` | 每个组件一个：结构、承诺、以及「页面上的值来自清单」 |

区块顺序：**首屏 → 凭据模型 → agent 一览 → 开始使用 → 边界 → 常见问题 → 更新日志 → 下载**。

Tailwind、React、i18next、lucide 的版本范围逐字取自 osw 的 `apps/www`，两侧保持同构。

## 文案口径

页面上的每句产品话都来自规格，不在官网现编：

| 主题 | 权威来源 |
| --- | --- |
| 安全叙事（舱里没有可泄漏的东西） | `apps/docs/specs/README.md`「与 OSW 的关系」、`product/functional-design.md` §7 |
| agent 的命令 / 上游 / 配置文件 | `packages/contracts/source/agents.ts`（import，不手抄） |
| agent 的镜像与持久化目录 | `apps/docs/specs/overview/agent-manifest.md`（字段尚未落地，页面如实写「还没」） |
| 怎么用（托盘 / 共享区 / 取回区） | `apps/docs/specs/product/first-experience.md`、`functional-design.md` §3 |
| 平台支持程度、`local` 后端不是沙箱 | `apps/docs/specs/overview/design.md` §5 |
| 托盘面板示意 | `apps/docs/specs/product/tray-ui.md` |
| 产品进度 | `apps/docs/roadmap.md` —— 页面上只写「开发中」，不承诺日期 |

硬规矩（都有测试守着）：

- **下载区在真有安装包之前不放任何链接或按钮。**
- **agent 数据只从清单读**，缺的字段如实写「清单未指定」，不借默认值冒充。
- **明确不承诺什么、什么情况下不适用，必须写在页面上**，不留给读者自己踩。

## 预渲染（首屏正文）

**为什么**：站点是 React 客户端渲染，`index.html` 原本只有一个空的 `#root`。爬虫、
社交平台的摘要抓取、关掉 JS 的浏览器都拿不到任何正文 —— 对一个讲「凭据不出舱」的
站点，这是可信度问题，不只是 SEO。

**怎么做**：`pnpm --filter @abx/www build` 依次跑三步（见 `package.json` 的 `build`）：

1. `vite build` —— 客户端产物落到 `output/`（CSS/JS 的哈希文件名在这里定下）；
2. `vite build --config vite.config.ssr.ts` —— 把 `source/entry-server.tsx` 打成
   Node 侧的 bundle，落到 `output-ssr/`（与客户端产物分开，两边不会互相清空）；
3. `node scripts/prerender.mjs` —— 导入那份 bundle 渲染整页，替换
   `output/index.html` 里唯一的 `<div id="root"></div>`，然后删掉 `output-ssr/`。

注入点找不到、或不唯一时构建**直接失败**，不会悄悄产出一份没有正文的页面。
没有新增运行时依赖：用的是 `react-dom` 自带的 `react-dom/server`。

**为什么只预渲染中文一份**：中文是源码里的原文，也是兜底语言（见 `i18n.ts`）；
英文是增量翻译，缺 key 会回落到中文。默认路径（没有 `?lang=en`，浏览器语言也不是
英文）就是中文，一份预渲染覆盖了绝大多数首屏。多语种预渲染要引入多份 HTML 和一套
按 URL 分派的静态路由，而站点本身没有路由，不值当。

**带 `?lang=en` / `?theme=light` 打开时**：`mount.tsx` 只在「预渲染的那份状态」与
当前页完全一致时才 `hydrateRoot`。判据（`hydration.ts`）是三条同时成立：`#root`
里已有标记、`i18n.language === 'zh'`、`data-theme === 'dark'`。

- `?lang=en`（或浏览器语言是英文、上次选过英文）：语言不同 → **`createRoot`**；
- `?theme=light`（或系统偏好浅色，内联脚本把 `data-theme` 写成 light）：主题不同
  → **`createRoot`**。

`createRoot` 不比对旧标记，整棵客户端树重画，所以不会有 hydration mismatch 报错，
也不会白屏；代价只是这两条路径少了一次 DOM 复用。预渲染时主题固定为深色，因为
构建时没有 `document`，`initialTheme()` 落到兜底值 `dark`，而 `useEffect` 在服务端
不执行 —— 主题会改变顶栏开关的图标与 `aria-label`，所以必须参与判据，不能只看语言。

**加新文案为什么不会破坏预渲染**：预渲染渲染的就是真正的 `App`，文案来自组件里的
`t(key, '中文')` 兜底和 i18n 资源，没有一份「预渲染专用文案表」需要同步。新文案会
自动进入 `output/index.html`。守着的测试有两层：`entry-server.test.ts` 断言渲染
结果里是正文（不是空壳）且两次渲染一致；`mount.test.tsx` 断言水合复用了已有的
DOM 节点、英/浅色路径走 `createRoot`，两边都不往控制台写 mismatch。唯一能悄悄破坏
它的是改掉 HTML 模板里的注入点，而那会以构建失败的形式出现。

## 命令

```bash
pnpm dev                                        # 开发服务器（#root 为空，走 createRoot）
pnpm --filter @abx/www build                    # 客户端构建 + 预渲染，产物在 apps/www/output
pnpm --filter @abx/www preview                  # 预览构建产物

# 视觉与可访问性（截图与报告落在 .state/，已 gitignore）
S=~/.openclaw/workspace/skills/design-review-loop/scripts
node $S/audit.mjs "http://localhost:4177/?theme=light&lang=zh" --viewport 390x844
bash $S/shot.sh "http://localhost:4177/?theme=dark&lang=zh" .state/page.png 1440x900
```

`?theme=` 与 `?lang=` 都可以在 URL 上钉住：截图、评审、分享一条固定外观的链接靠它。
