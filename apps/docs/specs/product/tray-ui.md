# abx 托盘 UI 规格（对齐 OSW）

> 依据：`/home/openclaw/Project/osw` 的 `packages/console/source/pages/tray/`（页面）、
> `packages/contracts/source/tray-panel.ts`（常量）、`apps/app/source/tray-manager*`（窗口）、
> `packages/console/source/styles/index.css`（设计令牌）。
> 视觉稿：`mock.png`（同目录）。

---

## 0. 最重要的一条：它是自绘窗口，不是原生菜单

OSW 的托盘看起来像菜单，实现是 **原生 `Tray` 图标 + 一个无边框透明 `BrowserWindow` 面板**，
面板里跑 React。四个证据：

| 证据 | 值 |
|---|---|
| 面板窗口宽度 | **422 px**（`tray-manager.test.ts` 断言 `width: 422`） |
| `TRAY_PANEL_GUTTER` | **28 px** —— 卡片外面那圈**透明留白**，专门给阴影用 |
| `html[data-surface='tray']` | `background-color: transparent`（窗口透明，底色只能由卡片自己画） |
| `useTrayPanelHeight` | 用 `ResizeObserver` 量卡片高度，**报给宿主窗口** |

所以：

- **不要**用 Electron 的 `Menu` / `setContextMenu` 做这个面板。原生菜单不能自绘、不能放列表、不能接拖拽落点。
- **卡片宽 366 px** = 422 − 28×2。窗口高度由内容决定，宿主跟着 `resize(height)` 走。

---

## 1. 窗口规格

| 项 | 值 | 说明 |
|---|---|---|
| 类型 | `BrowserWindow` | `frame: false`、`transparent: true`、`hasShadow: false` |
| 宽 | 422 | 固定 |
| 高 | 内容高度 + `TRAY_PANEL_GUTTER × 2` | 由渲染层通过 IPC 上报 |
| 其他 | `resizable: false`、`skipTaskbar: true`、`alwaysOnTop: true`、`fullscreenable: false` | |
| 位置 | 贴着托盘图标下方、屏幕内避让 | 参照 `tray-manager` 的锚点计算 |
| 关闭 | 失焦即隐藏（不要销毁），再次点击切换 | |

渲染层根节点必须：

```css
html[data-surface='tray'], html[data-surface='tray'] body {
  background: transparent;
  background-image: none;
}
html[data-surface='tray'] body {
  min-height: 0;          /* 基础样式里的 100vh 会让窗口比内容高一截 */
  user-select: none;
  overscroll-behavior: none;
}
```

---

## 2. 设计令牌（逐字取自 OSW）

### 2.1 字体

```
--font-sans: 'Geist Variable', -apple-system, 'SF Pro Text', 'PingFang SC', sans-serif
--font-mono: 'Source Code Pro', 'SF Mono', 'Fira Code', ui-monospace, monospace
```

### 2.2 排版刻度（`@utility system-*`，改自源码）

| 类 | 字号 | 字重 | 行高 |
|---|---|---|---|
| `system-2xs-regular` | 11 | 400 | 16 |
| `system-2xs-medium` | 11 | 500 | 16 |
| `system-xs-regular` | 12 | 400 | 16 |
| `system-xs-medium` | 12 | 500 | 16 |
| `system-sm-medium` | 13 | 500 | 16 |
| `system-sm-semibold` | 13 | 600 | 16 |

> 2xs 是 11px 而不是 10px —— OSW 的注释写了原因：10px 下中文笔画会粘连，且 11/16 与
> xs 以上共用同一条 4px 基线，行盒节奏不会在最小号字处突然变紧。**沿用这个决定。**

### 2.3 色板（HSL，值原样照抄）

| 令牌 | Light | Dark |
|---|---|---|
| `background` | `0 0% 98%` | `0 0% 7%` |
| `card` | `0 0% 100%` | `0 0% 12%` |
| `popover` | `0 0% 100%` | `0 0% 19%` |
| `foreground` | `0 0% 9%` | `0 0% 98%` |
| `secondary` | `0 0% 96%` | `0 0% 15%` |
| `muted` | `0 0% 96%` | `0 0% 15%` |
| `muted-foreground` | `0 0% 40%` | `0 0% 66%` |
| `accent` | `0 0% 9% / .08` | `0 0% 98% / .12` |
| `destructive` | `6 65% 48%` | `6 65% 42%` |
| `border` | `0 0% 90%` | `0 0% 20%` |
| `input` | `0 0% 90%` | `0 0% 16%` |
| `ring` | `0 0% 9%` | `0 0% 98%` |

**文字层级**（三级，每一级都在浅色卡与深色卡上实测过，全部 ≥ AA 正文的 4.5:1）：

| 档 | 取值 | 用途 | 浅色实测 | 深色实测 |
|---|---|---|---|---|
| `t-1` | `foreground`（100%） | 标题、条目名、在跑的 agent 名 | 17.9:1 | 15.8:1 |
| `t-2` | `foreground / .7` | 状态胶囊文字、段落标题 | 6.4–6.6:1 | 7.8–8.3:1 |
| `t-3` | `muted-foreground` | 副标题、未跑的 agent 名、计数、徽标、拖放提示 | 5.7:1 | 6.9:1 |

> OSW 那一版是四级，多一档 `t-4` = `foreground / .35`（最弱/计数）。**abx 不保留它**：
> 白卡上 `foreground/.35` 只有 2.22:1、`.5` 只有 3.41:1，AA 要求 4.5:1 —— 浅色主题里
> 「比 `muted-foreground` 更弱」根本没有合法取值空间。最弱的一档只能靠字号与字重表达，
> 不能靠把颜色继续往白里推。同理方块底从 `foreground/.14` 收到 `.10`：不收的话，
> `muted-foreground` 的字母压在上头只有 4.0:1。
>
> 数由 `pnpm --filter @abx/app verify:linux` 实测（明暗各一轮），不是按公式估的。

### 2.4 圆角与阴影

```
--radius: 0.375rem            /* 6px */
radius-sm = 2px, radius-md = 4px, radius-lg = 6px, radius-xl = 10px
```

卡片：`border-radius: radius-xl (10px)` +
`box-shadow: 0 8px 24px rgb(0 0 0 / .12), 0 1px 4px rgb(0 0 0 / .06)`
卡片边框：`foreground / .14`（对应 OSW 的 `components-panel-border`）

---

## 3. 布局（上排只有 icon，下方是文件列表）

**2026-10-23 定：agent 那一排只有 icon，没有名字。** 名字在**悬停**（以及键盘 `focus`）时出现。

```
┌─ 面板卡片 366×auto ─────────────────────────────────┐
│ header  56px  [icon28] abx                      ⚙   │
│               气闸运行中 · 凭据全部在舱外            │
├─────────────────────────────────────────────────────┤
│ agents  上排 icon · gap 8 · padding 12/14           │
│   ┌──────┐ ┌──────┐ ┌──────┐                        │
│   │  ✳   │ │  ⬡   │ │  ⌘   │   ← 44×44，只有 icon   │
│   └──────┘ └──────┘ └──────┘                        │
│        ↑ 名字只在悬停 / 聚焦时出现                   │
├─────────────────────────────────────────────────────┤
│ 共享给全部 agent                               3 项 │
│ ┌─ list ──────────────────────────────────────────┐ │
│ │ ▤ design-spec.pdf                       [只读]  │ │
│ │ ▤ api-contract.md                       [只读]  │ │
│ │ ▦ assets/                               [只读]  │ │
│ └─────────────────────────────────────────────────┘ │
│ ┌─ 拖到这里 → 全部 agent 立刻可见 ────────────────┐ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ 审计流水…                    停止全部        退出    │
└─────────────────────────────────────────────────────┘
```

| 区域 | 高度/间距 | 备注 |
|---|---|---|
| header | `min-height: 56px`，`padding: 0 14px`，`gap: 10px` | 图标 28px、`border-radius: 7px` |
| agents | `padding: 12px 14px`，`flex`，`gap: 8px` | **tile 44×44**，只有 icon，**无名字** |
| section | `padding: 0 14px 12px` | 段落标题 `system-2xs-medium`(t-2) + 右侧计数(t-3) |
| list 行 | `min-height: 40px`，`padding: 8px 10px` | 行间分隔 `foreground/.07` |
| drop zone | `padding: 12px 10px`，虚线 `foreground/.22` | 常驻提示，拖拽悬停时高亮 |
| footer | `padding: 8px 10px`，上边框 `foreground/.14` | 三个动作，`停止全部` 用 destructive |

### 3.1 icon-only 的四条硬规则

**① 为什么是 44。** 指针/触控目标的下限是 44×44，而审计查的就是这一条。
一行最多 **7 个**（7×44 + 6×8 = 356 ≤ 366），超过就**折行，不横滚**。左对齐——
个数从 1 变到 7 时不会跳位。

**② 名字在悬停「和」键盘 `focus` 时出现。** 只做 hover，等于把名字只给了鼠标用户；
触屏和键盘用户永远看不到它。用**自定义 tooltip**，不用原生 `title`——
原生延迟约 1 秒、样式在深浅色下不受控，而名字是这个面板上**唯一的文字信息**，不该有延迟。
tooltip 内容带状态：`Claude Code · 运行中，点击聚焦`。

**③ 没有名字的图形，必须有一个能读出来的名字（硬要求）。** tile 上必须有
`aria-label="Claude Code · 运行中"`，否则屏幕阅读器拿到的是一个**无名按钮**。
视觉上省掉的文字，要在别处补回来。

**④ 只显示已安装的 agent。** 这是 icon-only 带来的必然结果——你不可能用一个图标
代表一个还没装的 agent：它既没有可辨认的身份，也没有可执行的动作。
所以 **dsh 在镜像构建完成前不进托盘**，而 `agents` 这一排里也就**不存在「不可用」这一档**
（那属于管理面板）。原来的三档分类（运行中 / 未运行 / 不可用）因此降成**两档**。

---

## 4. 状态

| 状态 | 表现 |
|---|---|
| **气闸运行中** | header 副标题「气闸运行中 · 凭据全部在舱外」 |
| **气闸未就绪** | 副标题换成一句「为什么 + 去哪配」；tile 全部禁用 |
| **agent 运行中** | tile：强调描边 + 右下角**实心**点；tooltip 带「运行中」 |
| **agent 未运行** | tile：中性描边 + **空心**圈；tooltip 带「点击启动」 |
| **共享区为空** | 列表区换成一句引导 + 虚线框（文案见 §7） |
| **拖拽悬停** | 面板/卡片外框变 `ring` 2px + 虚线框底色 `muted` |
| **条目模式** | `只读` 徽标（后续若有可写条目，改用不同徽标，不换布局） |

**形状承载状态，颜色只是补充。** 这一排已经没有文字了，如果连形状（实心 / 空心）都一样，
状态就只剩颜色——那正是我们明令禁止的。所以：**实心 vs 空心**是第一通道，
颜色是第二通道，tooltip 与 `aria-label` 是第三通道。

---

## 5. 交互

1. **拖到托盘图标**（`Tray` 的 `drop-files`，**macOS only**）→ `mounts.addSharedEntries(files)` → 面板刷新
2. **拖到面板虚线区**（HTML5 `dragover`/`drop`）→ 同上
3. **点 agent tile** → `session.create(...)`；已在跑则聚焦该舱窗口
4. **条目右键** → 移除（只解除挂载，**不删原文件**）
5. **点外部** → 面板隐藏（不销毁）

---

## 6. 不做

- 原生 `Menu` 做面板
- 多级子菜单 / 任意层级树
- 面板内滚动长列表（超过 N 条改为「查看全部」跳主窗口）
- 自带一套新皮肤：**面板不是另一套设计系统，就是 OSW 那套令牌换一种排布**

---

## 7. 待阿来确认

1. ~~是否跟随系统自动切换明暗~~ —— **已定：跟随系统，面板内不放切换器**（`design-system.md §8`）
2. ~~三个方块是启动按钮还是状态指示~~ —— **已定：两者都是**（实心=在跑，点=启动 / 聚焦，且幂等），
   详见 `functional-design.md` J3
3. **空态文案**：建议改成 `拖到这里 → 全部 agent 立刻可见`。
   原句「把文件拖到**托盘图标**」把面板和托盘图标混成了一句，而拖到托盘图标是 **macOS only**
   （Windows 上 `Tray` 不接拖放）——面板内的文案**只说面板**，平台相关的写法不进正文。
4. **`审计流水…` 与 `停止全部` 在 footer 是否都还必要**：`functional-design.md §13` 把首页
   砍到两件事，但这套 footer 还没跟着重算，下次一起收。
