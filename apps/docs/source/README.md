# source/ —— 面向使用者的文档

这里放**给使用者看的**文档：怎么装、怎么第一次跑起来、托盘怎么用、出问题了怎么办。
它会被 `clarify build` 发布成静态站。

**和 `specs/` 的区别：**

| | `specs/` | `source/` |
|---|---|---|
| 读者 | 实现者、评审者 | 使用者 |
| 写什么 | 哪里会出错、什么没验证、为什么这么取舍 | 怎么用 |
| 进静态站 | ❌ | ✅ |

规格里有尚未落地的取舍和未验证的结论，不能当成产品承诺，所以不挂进导航。
站点结构只写在 `../clarify.ts`，本文件不重复。

## 目录与语言

- `zh/` 是默认语言，也是内容的权威版本；它占据根路径（`/inside/credentials`）。
- `en/` 挂在 `/en` 前缀下；缺哪一页就自动回退中文（`missing: 'fallback'`），
  不会出现 404，也不会出现点开是空白的导航项。
- 两个语言目录的 slug 必须一一对应：`zh/inside/egress.mdx` 对应
  `en/inside/egress.mdx`。

## 加一页

1. 在 `zh/` 下按位置新建 `.../<slug>.mdx`，开头写 `title` 与 `description`
   （`description` 会进搜索结果和页面摘要）。
2. 在 `../clarify.ts` 对应的 tab / group 里加一条 `{ page: '<slug>', title: ... }`。
   导航、分组和页面标题都要写成 `{ zh, en }` 两语。
3. 跑 `pnpm test`。`docs.test.ts` 会检查导航里的每一页都有中文文件、中文文件都在导航里、
   站内链接能落到某个页面。
4. 需要英文时，在 `en/` 下建同 slug 的文件，并更新下面的进度表。

**一个主题只在一页里展开**，其它页提到它只写结论加链接。

## 加一种语言

1. 在 `../clarify.ts` 的 `locales.locales` 里加 `{ code, label }`。
2. 建 `source/<code>/` 目录，至少放一页 `index.mdx`；其余页面靠 `missing: 'fallback'` 回退。
3. 站点级 `title` / `description` 目前是单值（默认语言），新增语言时一并确认是否需要调整。

## 数据不要手抄

agent 的名字、命令、配置落点、上游、状态都来自
`packages/contracts/source/agents.ts`；镜像默认值来自 `packages/contracts/source/schema.ts`。
页面通过 `source/data/agents.ts` 读它们，不在这里再抄一份：

- `agents/available` 的表格全部由 `AGENT_DOCS` 渲染；
- `inside/config` 的示例路径取自清单；
- 除上述页面之外出现的路径、镜像名等 Markdown 数据，由 `docs.test.ts` 对照清单校验。

新增 agent 时改清单即可，文档会跟着变；`docs.test.ts` 会挡住两边漂移。

## 译制进度

英文按页增量补。**这张表是唯一来源**，其它地方不重复记录。

| 页面 | 中文 | English |
|---|---|---|
| `index` | ✅ | ✅ |
| `getting-started/installation` | ✅ | ⏳ |
| `getting-started/first-run` | ✅ | ⏳ |
| `inside/credentials` | ✅ | ⏳ |
| `inside/config` | ✅ | ⏳ |
| `inside/egress` | ✅ | ⏳ |
| `inside/history` | ✅ | ⏳ |
| `agents/available` | ✅ | ⏳ |
| `agents/upstream` | ✅ | ⏳ |
| `limits/troubleshooting` | ✅ | ⏳ |
| `limits/limitations` | ✅ | ⏳ |

`⏳` 的页面在 `/en/...` 下回退中文，不是 404。
