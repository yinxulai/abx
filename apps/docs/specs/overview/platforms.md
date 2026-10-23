# 平台差异与 Linux 开发链路

> 本文只回答两件事：**哪些行为必须按平台分叉**，以及**在没有显示器的 Linux 开发机上
> 能验到哪一步、验不到哪一步**。
> 面板的视觉令牌与布局尺寸不在本文重复，见 [`../product/tray-ui.md`](../product/tray-ui.md)；
> 整体进度与验收状态见 [`../../roadmap.md`](../../roadmap.md)。

---

## 0. 定位：Linux 是开发机，不是发布平台

abx 是 **macOS 托盘应用**，只做 macOS。Linux 存在的唯一理由是：
**开发机就是 Linux，而且没有物理显示器**。所以 Linux 侧只有两个目标：

1. `pnpm --filter @abx/app dev` 能起来（不然改一行主进程代码都没法试）；
2. 面板能被**截图看见**（不然「面板长什么样」永远只能靠推测）。

由此推出两条硬约束，本文后面所有取舍都服从它们：

- **不为了 Linux 改 macOS 的既有行为。** 需要分叉的地方就显式分叉，不共用一条路径。
- **平台判断只留在宿主层。** 全部集中在 `apps/app`，`packages/core` 里不出现
  `process.platform`（领域逻辑不该知道自己在哪个系统上跑）。

---

## 1. 必须分叉的地方

| # | 项 | macOS | Linux（开发机） | 落点 |
|---|---|---|---|---|
| 1 | 沙箱 | 系统/安装包保证 `chrome-sandbox` 归 root 且有 setuid 位 | 开发机上的 `chrome-sandbox` 既不是 root 也没有 setuid 位，Electron **直接拒绝启动** | [`apps/app/scripts/electron-sandbox.mjs`](../../../../apps/app/scripts/electron-sandbox.mjs) |
| 2 | 托盘图标 | `trayTemplate.png`：模板字形，系统按菜单栏配色自动反色 | **没有模板语义**，彩色图原样放上去 | `trayIcon()`，`apps/app/source/main.ts` |
| 3 | 托盘锚点 | `Tray.getBounds()` 给出菜单栏图标位置，面板贴它下方 | 没有托盘宿主，`getBounds()` 没有可信值 | `placePanel()` —— **未验证，见 §5** |
| 4 | 透明窗口 | 有合成器：alpha 真的透明，28px 留白是空的 | Xvfb 没有合成器：alpha=0 被画成**纯黑** | 环境问题，非代码问题，见 §4 |
| 5 | 拖到托盘图标 | `Tray` 的 `drop-files`（**macOS only**） | 该事件不存在 | 面板内的 HTML5 拖放两边都能用 |
| 6 | 字体 | `SF Pro Text` / `PingFang SC` | 两者都没有，落到 `Noto Sans CJK SC` | `--font-sans` 末尾的 `sans-serif` 兜住了 |
| 7 | 主题 | 跟随系统外观 | 没有系统外观可跟，默认浅色 | `styles.css` 的 `@media (prefers-color-scheme: dark)` |

三处的取舍说明：

**#1 沙箱。** 不装系统级依赖（`apt install` 一概不做），所以走「检测 + 降级」：
先看 `chrome-sandbox` 是不是 `uid === 0` 且有 `04000` 位，只有不可用时才追加
`--no-sandbox`，并且**把降级动作打出来**——静默降级会让人以为沙箱还在。
本机 `ldd` 检查过 Electron 二进制的动态依赖，**没有缺库**，卡住的只有这一个 setuid 位。

> 这是**开发机跑 `node_modules` 里的 Electron** 才会碰到的问题，不是 Linux 的通病：
> `deb` 的 `postinst` 会自己处置——若内核支持 user namespace（`unshare --user true`
> 能跑通）就把 `chrome-sandbox` 设成 `0755`，否则设成 `4755`（见该包的维护者脚本）。
> 也就是说**装出来的 deb 不需要用户手动加 `--no-sandbox`**；而 `AppImage` 走的是
> electron-builder 内建的取舍，它的 `.desktop` 里直接写着 `Exec=AppRun --no-sandbox %U`。

**#2 托盘图标。** macOS 那份 16×16 的模板字形在别的平台会变成一块黑色方块（模板图的
像素本来就是黑 + alpha，靠系统反色）。Linux 用彩色应用图标 `icon.png`，但它是 1024px 的
方图，直接塞进 20 出头像素的托盘槽位会被缩得没法看，所以先 `resize` 到 22px 再交给 `Tray`。

**#7 主题。** 明暗不是「Linux 特例」——它是 `prefers-color-scheme` 的标准行为，
两个平台走的是同一条路径。列在这里是因为**开发机上只能靠强制才看得到深色**（见 §2）。
是否要跟随系统仍是待拍板项，见 [`../product/tray-ui.md`](../product/tray-ui.md) §7。

---

## 2. 一条命令的无头验证入口

```bash
pnpm --filter @abx/app verify:linux          # 明暗两套都跑
pnpm --filter @abx/app verify:linux -- --scheme dark --no-build   # 只跑深色，跳过构建
```

链路是：**构建 → 起 Xvfb → 起 Electron → 等渲染收敛 → 明暗各跑一轮 → 拆干净**。
主进程靠 `ABX_PANEL_SHOW_ON_START=1` 开局就把面板摊开——没有托盘宿主，点不到图标。

产物全部落在 `apps/app/.state/`（**已 gitignore，不进仓库**）：

| 文件 | 它证明什么 |
|---|---|
| `panel-x11.png` | 窗口**真的映射到了显示器上**。X 服务器的整屏截图，能看见卡片外那圈 28px（截图里是黑色，见 §4） |
| `panel-renderer.png` | 渲染进程自己的像素，带 alpha、2 倍密度。**看设计用这张**：没有黑圈 |
| `panel-text.txt` | 面板渲染出来的**文本**。「不是白屏」靠断言这段文本，不靠肉眼看图 |
| `contrast.json` | 面板里每个文字元素的对比度实测（前景已按 alpha 合成到底色上），跑在**真实渲染进程**里 |
| `audit.json` | 程序化 UI 审计：对比度 / 溢出 / 触控目标 / 字号间距 / 焦点态 |
| `panel-x11-dark.png` 等带 `-dark` 的 | 以上四份在深色配色下的对应物 |

为什么深色要单独跑一轮：**浅色卡和深色卡上「同一档灰」的对比度能差出一倍**，
只量一套等于只验证了一半。两轮的配色是强制的，不是等系统给：

- 渲染进程一侧用 CDP 的 `Emulation.setEmulatedMedia`，并且**当场读卡片自己的计算底色
  核对**（浅色 `rgb(255,255,255)`、深色 `rgb(31,31,31)`）——强制没生效就得报错，
  不能安静地量出一份「深色也没问题」的假结论。
- 审计脚本自己拉的那个 Chrome 用 Blink 的 `preferredColorScheme=0`。
  **同一个二进制、加不加壳各跑一次**做对照组，确认「不加壳 = 浅色、加壳 = 深色」——
  不然「壳没生效」和「真的全绿」在报告里长得一模一样。

---

## 3. 两个踩过的坑（改这个脚本前先看）

**审计为什么需要一个静态 HTTP 服务。** 审计脚本自己拉一个 headless Chrome，
而**普通 Chrome 在 `file://` 下会按 CORS 拒掉 ES 模块脚本与样式表**，页面只会剩一个空壳。
Electron 不做这个限制，所以 app 里一切正常——这个差异只在审计这条路上咬人。
于是 `verify:linux` 起一个极简静态服务，把同一份产物用 `http://` 递给它：
审的是同一份 DOM 与 CSS，不是另一份。

**为什么必须用异步 `spawn` 而不是 `spawnSync`。** 那个静态服务就跑在同一个 Node 进程里。
`spawnSync` 会卡住事件循环，服务器再也回不了响应，Chrome 那份页面永远加载不完——
两边一起挂死，表现为「没有任何输出地停住」。

---

## 4. 透明窗口在没有合成器时的真实表现

面板窗口是 `transparent: true` + `frame: false`，卡片外那圈 28px 留白是**留给阴影的透明区**。
X11 的透明要靠合成器（compositing manager）实现；**纯 Xvfb 没有合成器，alpha=0 会被画成
纯黑**。实测（在整屏截图上取像素）：

| 位置 | 浅色下的像素 | 深色下的像素 |
|---|---|---|
| 卡片外的留白（如 `x=20, y=250`） | `rgb(0,0,0)` | `rgb(0,0,0)` |
| 卡片内部（如 `x=60, y=250`） | `rgb(255,255,255)` | `rgb(31,31,31)` |

卡片边界落在 `x=56` 设备像素 = 28 CSS 像素 × 2 倍密度，与
[`../product/tray-ui.md`](../product/tray-ui.md) §0 记的 `TRAY_PANEL_GUTTER = 28` 对得上。

**这不是 bug，是环境。** 有合成器的真实桌面上这圈是空的；无头截图里它必然是黑的。
所以「看设计」要看 `panel-renderer.png`（渲染层自己的像素，带 alpha），
不要拿 X11 整屏截图去评视觉。

---

## 5. 实测结论 vs 尚未取得证据的判断

**已实测（有真实输出）**

- Electron 在 Xvfb 上能起来、能渲染：卡片 366×229 CSS 像素，与规格一致。
- 没有托盘宿主时 `new Tray()` **不抛异常**（提示图标没人显示，但进程不崩）。
- 面板的文本是完整渲染出来的，中文不是豆腐块（`fc-match "sans-serif:lang=zh-cn"`
  → `Noto Sans CJK SC`）。
- 明暗两套的对比度都实测过，逐元素数值见 [`../product/tray-ui.md`](../product/tray-ui.md) §2.3。
- 本轮 `audit.json` / `audit-dark.json`：**致命 0 / 重要 0 / 次要 0**。
- `--linux --x64` 能产出两种产物：AppImage（125 269 463 B）与 deb（98 993 580 B）。
- 拆开 deb 量到的真实元数据：`Package: abx`、`Version: 0.1.0`、`Architecture: amd64`、
  可执行文件 `/opt/ABX/abx`、图标 `usr/share/icons/hicolor/1024x1024/apps/abx.png`、
  `.desktop` 里 `Categories=Development;`、`Exec=/opt/ABX/abx %U`。
  CI 的产物断言就是照这些值写的（`package-linux.yml`）。
- **从 deb 里解出来的那份可执行文件真的起得来**：`/tmp` 下的解包目录里，
  `opt/ABX/abx --no-sandbox` 在 Xvfb 里加载了
  `app.asar/output/panel/index.html` 并渲染出完整面板（截图见 `.state/`）。
  不加 `--no-sandbox` 时它按预期中止，报的正是第 1 条那个 setuid 错误。

**尚未取得证据的判断（不许当已通过）**

| 项 | 为什么还没验 |
|---|---|
| **托盘锚点定位**（`placePanel()`） | 没有托盘宿主，`Tray.getBounds()` 没有可信值；开发机与 CI 都不是 macOS。**三个平台上一个都没验过** |
| **安装流程本身** | deb 是打出来了、解包后也能跑，但**从没 `dpkg -i` 装过**（那需要 root）。`postinst` 里那段 chrome-sandbox 权限判断、`update-alternatives` 建 `/usr/bin/abx`、AppArmor profile，都只在源码层面读过，没实跑过 |
| **AppImage 直接运行** | 只验到「可执行位在、`.desktop` 里的 Exec 是 `AppRun --no-sandbox`」；本机没有 FUSE，**没双击过、也没直接执行过整包** |
| **CI 流水线** | `package-linux.yml` 是照本机实测值写的，产出断言在本机对真实产物跑通过；但**这条 workflow 还没在 GitHub runner 上跑过一次** |
| **`drop-files`（拖到托盘图标）** | macOS only，本机既没有该事件也没有托盘 |
| **真实桌面上的透明表现** | 无头环境没有合成器，见 §4 |
| **Windows** | 本版不做，配置里也没有 |

---

## 6. 归属

如果将来按 [`../README.md`](../README.md) 的规划开出 `platform/` 簇
（macOS 打包与宿主适配），**本文整体迁到那一簇**，本文的链接同步改写。
