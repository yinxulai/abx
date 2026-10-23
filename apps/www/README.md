# @abx/www

产品官网：一页落地页，讲清「abx 是什么、为什么安全」。Vite + React + Tailwind v4
（CSS-first，没有 `tailwind.config.js`），纯静态产物。

**现状**：单页，六个区块按「是什么 → 为什么安全 → 怎么用 → 边界 → 下载」排布。
没有路由、没有 i18n、没有部署配置 —— 等有实际需要再加。

## 结构

| 路径 | 职责 |
| --- | --- |
| `source/index.css` | 设计令牌（`@theme`）、基础层、`bg-grid` 工具类。改配色只改这一处 |
| `source/App.tsx` | 只负责背景层与区块顺序，不写文案 |
| `source/components/*` | 一节一个文件，文案跟着所属区块走 |
| `source/components/airlock-mark.tsx` | 品牌标记（装饰，`aria-hidden`） |
| `index.html` | 标题、描述、`theme-color` |
| `source/App.test.tsx` | 结构与承诺的回归测试（jsdom） |

Tailwind 的版本范围逐字取自 osw 的 `apps/www`，两侧保持同构。

## 文案口径

页面上的每句产品话都来自规格，不在官网现编：

| 主题 | 权威来源 |
| --- | --- |
| 安全叙事（舱里没有可泄漏的东西） | `apps/docs/specs/README.md`「与 OSW 的关系」、`product/functional-design.md` §7 |
| 怎么用（托盘 / 共享区 / 取回区） | `apps/docs/specs/product/functional-design.md` §3 |
| 托盘面板示意 | `apps/docs/specs/product/tray-ui.md` |
| 产品进度 | `apps/docs/roadmap.md` —— 页面上只写「开发中」，不承诺日期 |

两条硬规矩，都有测试守着：

- **下载区在真有安装包之前不放任何链接。**
- **只写已经设计好的能力**，同时把明确不承诺的三条写在页面上。

## 命令

```bash
pnpm dev                                        # 开发服务器
pnpm --filter @abx/www build                    # 构建到 apps/www/output
pnpm --filter @abx/www preview                  # 预览构建产物
```

## 尚未引入

osw 官网用的 i18n（`i18next` / `react-i18next`）与图标库没有引 ——
这一页是单语静态页，引进来只是多两份要跟着升级的东西。将来真要做双语时，
按 `AGENTS.md`「依赖选型」的规矩照抄 osw 的版本范围。
