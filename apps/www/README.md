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

## 命令

```bash
pnpm dev                                        # 开发服务器
pnpm --filter @abx/www build                    # 构建到 apps/www/output
pnpm --filter @abx/www preview                  # 预览构建产物

# 视觉与可访问性（截图与报告落在 .state/，已 gitignore）
S=~/.openclaw/workspace/skills/design-review-loop/scripts
node $S/audit.mjs "http://localhost:4177/?theme=light&lang=zh" --viewport 390x844
bash $S/shot.sh "http://localhost:4177/?theme=dark&lang=zh" .state/page.png 1440x900
```

`?theme=` 与 `?lang=` 都可以在 URL 上钉住：截图、评审、分享一条固定外观的链接靠它。
