# 平台差异与三平台链路

> 本文只回答两件事：**哪些行为必须按平台分叉**，以及**每个平台上能验到哪一步、
> 验不到哪一步**。
> 面板的视觉令牌与布局尺寸不在本文重复，见 [`../product/tray-ui.md`](../product/tray-ui.md)；
> 三个平台各自的跑法与排障见 [`../operations/windows-runbook.md`](../operations/windows-runbook.md)（Windows）
> 与本文 §2（Linux）；整体进度与验收状态见 [`../../roadmap.md`](../../roadmap.md)。

---

## 0. 定位：三个平台，三种角色

| 平台 | 角色 | 拿它证明什么 |
|---|---|---|
| **macOS** | 发布平台 | 用户真正会装的那个包。托盘、菜单栏、`chrome-sandbox` 都按它设计 |
| **Windows** | **使用者的日常测试平台** | 「换一台机器还能不能跑」这条最容易被忽略的验收。CI 上有一个真 runner 在跑测试 |
| **Linux** | 开发机 | 改代码的地方，**没有物理显示器**。只服务「能起来」与「能截图」两件事 |

三者的优先级是有次序的：**平台分叉以 macOS 为基准**（不为了别的平台改 macOS 的既有
行为，需要分叉就显式分叉），**Windows 是必须真的能跑的那一个**（因为它是日常测试机），
**Linux 只要求开发可用**。

由此推出三条硬约束，本文后面所有取舍都服从它们：

- **不为了别的平台改 macOS 的既有行为。** 需要分叉的地方就显式分叉，不共用一条路径。
- **平台判断只留在宿主入口。** `process.platform` 全仓库只在
  [`host-platform.ts`](../../../../packages/core/source/host-platform.ts) 的入口处读一次，
  由 [`apps/app/source/main.ts`](../../../../apps/app/source/main.ts) 读、往下传；
  `packages/core` 内部不出现它（领域逻辑不该知道自己在哪个系统上跑）。
  这条不只是洁癖：**判定必须是可注入的**，否则「Windows 上规则对不对」只能在一台
  Windows 上看，而写代码的机器是 Linux（见 §1 末）。
- **地址靠探测，不靠常量。** 宿主上哪张网卡能 bind、舱内打哪个名字到得了宿主，
  三个平台三个答案，而且 Docker Desktop 换代就会变（见 [`../operations/docker-verification.md`](../operations/docker-verification.md) §2）。

---

## 1. 必须分叉的地方

| # | 项 | macOS | Windows | Linux（开发机） | 落点 |
|---|---|---|---|---|---|
| 1 | 沙箱 | 系统/安装包保证 `chrome-sandbox` 归 root 且有 setuid 位 | 不适用（没有 setuid 这套东西） | 开发机上的 `chrome-sandbox` 既不是 root 也没有 setuid 位，Electron **直接拒绝启动** | [`apps/app/scripts/electron-sandbox.mjs`](../../../../apps/app/scripts/electron-sandbox.mjs) |
| 2 | 托盘图标 | `trayTemplate.png`：纯白 + alpha 的模板字形，系统按菜单栏配色自动反色（开发版走 `trayTemplate-dev.png`，多一颗圆点） | `build/icon-win.ico`（多尺寸 16/20/24/32/48/64/256），**原尺寸交给 `Tray`**，不预缩放 | **没有模板语义**，彩色 `icon.png` 缩到 22px 再放上去 | `trayIcon()` / `trayTemplate()`，`apps/app/source/main.ts` |
| 3 | 托盘锚点 | `Tray.getBounds()` 给出菜单栏图标位置，面板贴它下方 | `getBounds()` 给出任务栏通知区域图标的位置；任务栏可以在上下左右任一边 | 没有托盘宿主，`getBounds()` 没有可信值 | `panelPosition()`，[`apps/app/source/panel-position.ts`](../../../../apps/app/source/panel-position.ts) —— **纯函数、有单测；真机外观未验证，见 §5** |
| 4 | 透明窗口 | 有合成器：alpha 真的透明，28px 留白是空的 | 有合成器（DWM） | Xvfb 没有合成器：alpha=0 被画成**纯黑** | 环境问题，非代码问题，见 §4 |
| 5 | 拖到托盘图标 | `Tray` 的 `drop-files`（**macOS only**） | 该事件不存在 | 该事件不存在 | 面板内的 HTML5 拖放三个平台都能用 |
| 6 | 字体 | `SF Pro Text` / `PingFang SC` | `Segoe UI` / `Microsoft YaHei`（都靠 `sans-serif` 兜） | 两者都没有，落到 `Noto Sans CJK SC` | `--font-sans` 末尾的 `sans-serif` 兜住了 |
| 7 | 主题 | 跟随系统外观 | 跟随系统外观 | 没有系统外观可跟，默认浅色 | `styles.css` 的 `@media (prefers-color-scheme: dark)` |
| 8 | **宿主路径规则** | POSIX 禁挂前缀 + `/private/...` 解析 | 盘根、`C:\Windows`/`Program Files`/`ProgramData`、UNC `\\server\share`、ADS `file:stream` | POSIX 禁挂前缀 + `/run` | [`host-platform.ts`](../../../../packages/core/source/host-platform.ts)（三套 `HostPathRules`），判定点在 `mount-policy.ts` / `shared.ts` |
| 9 | **可执行文件查找** | `PATH` 里按名字找 | `PATH` + `PATHEXT`：`docker` 要按 `docker.exe` 找，`pnpm` 是 `pnpm.cmd` | `PATH` 里按名字找 | `findCommandOnPath()` / `isExecutableOnPath()`，[`host-command.ts`](../../../../packages/core/source/host-command.ts) |
| 10 | **路径分隔符与大小写** | `/`，区分大小写 | `\` 与 `/` 都算分隔符，**不区分大小写** | `/`，区分大小写 | `hostPathRulesFor(platform).path` 一律用 `path.posix` / `path.win32` 的显式那一份，不用宿主 `path` |
| 11 | **舱内路径** | 永远是 Linux 路径 | 永远是 Linux 路径 | 永远是 Linux 路径 | [`session/cell-path.ts`](../../../../packages/core/source/session/cell-path.ts) —— 舱内路径**不跟着宿主分叉**，这是最容易在 Windows 上写错的一处 |
| 12 | 打包目标 | `dmg` + `zip`（未签名） | `nsis` 安装包 + `portable` 单文件（**未签名**） | `AppImage` + `deb` | [`electron-builder.config.cjs`](../../../../apps/app/electron-builder.config.cjs)、根 `package.json` 的 `release:*` |

**第 2、3 条为什么在 Windows 上要单独分叉。** macOS 的模板图是「纯白 + alpha」，
靠系统反色（系统只取 alpha，我们给的 RGB 根本不参与）；Windows 的托盘没有模板语义，
也没有 Linux 那种「缩到 22px」的理由
——`.ico` 里本来就装着 16 到 256 的七档尺寸（16/20/24/32/48/64/256），系统按 DPI 自己挑，
我们**再缩一次反而会把 256 那档毁掉**。锚点那边则是几何问题：macOS 的菜单栏固定在
屏幕顶，Windows 的任务栏可以在四条边的任意一条上，所以位置得由
「托盘图标矩形 + 工作区矩形」算出来，而不是写死「贴下方」。那套计算被抽成纯函数
`panelPosition()`，于是「任务栏在下面/上面/右边」这些在 Linux 上就能验。

**第 8 到 11 条是这次 Windows 支持里最实的部分。** 一台 Windows 机器上，
`C:\Users\dev\notes` 与 `/home/dev/notes` 是两种完全不同的东西：前者是绝对路径，
后者在 Windows 上**也是绝对路径**（`\` 开头指当前盘），而两者拼出来的字符串在
另一套分隔符下又都不是路径。所以每个判定都必须问「按**哪个平台**的规则判」，
而不是问「我这台机器怎么判」——这也是为什么平台是**传进来的参数**而不是就地读的：

> 判定点全部是纯函数，输入里带 `platform`。于是「Windows 的禁挂前缀对不对」
> 这类问题可以在 Linux 上跑完整的单测（`session/test-support.ts` 为三个平台各造
> 一套路径词汇表），而不必开一台 Windows。**不许**写成 `if (process.platform === 'win32')`：
> 那样这些分支只有 Windows 能执行到，等于没有测试。

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

**#2 托盘图标。** macOS 那份 16×16 的模板字形在别的平台会变成一块白色方块（模板图的
像素本来就是纯白 + alpha，靠系统反色；白色压在浅色菜单栏上同样是隐形的，
所以 `trayIcon()` 显式调 `setTemplateImage(true)`，不赌文件名那套启发式）。
Linux 用彩色应用图标 `icon.png`，但它是 1024px 的
方图，直接塞进 20 出头像素的托盘槽位会被缩得没法看，所以先 `resize` 到 22px 再交给 `Tray`。
Windows 用 `icon-win.ico`：`.ico` 自带多档尺寸（16/20/24/32/48/64/256），
**交给 `Tray` 时不做预缩放**——缩一次等于把 256 那档废掉，而 DPI 缩放时系统要的正是它。

**#7 主题。** 明暗不是「Linux 特例」——它是 `prefers-color-scheme` 的标准行为，
三个平台走的是同一条路径。列在这里是因为**开发机上只能靠强制才看得到深色**（见 §2）。
是否要跟随系统仍是待拍板项，见 [`../product/tray-ui.md`](../product/tray-ui.md) §7。

### 1.1 舱面地址：一个「两件事被当成一件事」的 bug

「容器往哪个地址打宿主」与「宿主 broker 绑哪张网卡」是两个问题，而代码里长期
只有第一个（`cellHost`），第二个跟着它走。在原生 Linux docker 上这两个恰好都是
`172.17.0.1`，所以一直没露馅；Docker Desktop 上**压根没有 `172.17.0.1` 这张网卡**，
`listen` 直接 `EADDRNOTAVAIL`，而报错说的是「舱面起不来」，读起来像端口被占用。

修法是把它拆回两件事（见 [`../operations/docker-verification.md`](../operations/docker-verification.md) §3）：

| 问题 | 谁定 | 落点 |
|---|---|---|
| 舱面**绑**哪张网卡 | `bindHostCandidates()`：显式覆盖 > local 回环 > 配置里的字面 IP > `0.0.0.0` | `broker/cell-host.ts`，被 `startBroker` 按序试绑 |
| **告诉舱内**哪个地址 | `decideCellHost()`：从舱内依次探候选，取第一条真的通的 | 同上（**判定已落地并有单测，尚未接进 `open` 的会话路径**，见 §5） |

两个名字不能互换：`host.docker.internal` 是**舱内**的名字，在宿主上拿它去
`listen()` 要么 `EADDRNOTAVAIL` 要么绑到一张没想过的网卡上。所以候选表里只有
字面 IP（判据是 `net.isIP`，纯字符串、不查 DNS，三个平台同一份行为）。

---

## 2. 一条命令的无头验证入口（Linux）

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

**规则：一个平台上的证据只算那个平台的。** 下面按平台分开列，**不许把 A 平台的
绿当成 B 平台的绿**——这正是本文存在的理由。

### 5.1 Linux（开发机）

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

### 5.2 Windows

**已实测**

- **`lint` / `typecheck` / `test` / `build` 四样在 `windows-latest` 上全绿**，
  每一条都跑在真 runner 上（不是本地模拟）。CI 的 `Windows` job：
  `.github/workflows/ci.yml`，由 push 触发（`main` 与 `lane/**`）。
- **第一次跑就把差异全抖出来了**：`Test Files 10 failed | 43 passed (53)`、
  `Tests 83 failed | 646 passed (729)`。逐条看下来，绝大多数是**测试自己的假设**
  （用宿主的 `path.join` 拼舱内路径、把 `C:\...` 拿去 `split(':')`、
  拿 `/etc` 当「这台机器上一定存在且禁挂」的位置），不是产品行为错。
  修法一律是「按平台分开断言」，没有一条是靠删断言换绿的。
- Windows 专属的判定（盘根 / UNC / ADS / `PATHEXT` / 大小写不敏感）在 Linux 上
  由 `session/test-support.ts` 的 `hostVocabulary('win32')` **跑完整单测**——
  这是「平台是注入进来的」买到的东西。

**没验的（见 §5.4）**：托盘图标**长什么样**、安装包**装起来怎么样**、
真容器**在 Windows 上起不起得来**。CI 上不跑 e2e，也不跑打包。

### 5.3 macOS

**已实测**：无。这一栏是空的，原因见 §5.4 第一行。

### 5.4 尚未取得证据的判断（不许当已通过）

| 项 | 为什么还没验 |
|---|---|
| **macOS 真机** | 开发机与 CI 都不是 macOS。**托盘、签名、`drop-files`、`/private/...` 软链、VM 网关地址全部只按文档与代码推过** |
| **托盘图标长什么样**（三个平台） | 图标文件在、被 `Tray` 接受、不抛异常，这三条在 Windows 与 Linux 上验得到；**「看着对不对」要人眼，而跑 CI 的机器没有桌面**。`icon-win.ico` 的多档尺寸是**按 Electron 的要求生成的，不是按观感挑的**；macOS 那份还多一个只有真机能走到的地方——`app.isPackaged` 挑正式/开发两张模板图（开发版右下角多一颗圆点，见 `trayTemplate()`） |
| **托盘锚点定位** | 无头环境里 `Tray.getBounds()` 没有可信值。**几何计算**（`panelPosition()`）有 7 条单测，覆盖任务栏在下/上/左/右与贴边夹取；**真机上面板到底落在哪，三个平台都没看过** |
| **Windows 安装包** | `package-windows.yml` 会产出 `nsis` 与 `portable`，并对**真实产物**断言（两个 exe 都在、PE32+ 头 `0x20b`、子系统 `2` = GUI、`app.asar` 里的图标清单）。但 **`nsis` 从没装过、`portable` 从没双击过**；也**没有签名**，所以 Windows 上一定会弹 SmartScreen |
| **Windows 上起真容器** | CI 上不跑 e2e（那几个脚本是 bash + docker）。`abx open` 在 Windows 上到底能不能把舱起起来，**没有证据** |
| **`drop-files`（拖到托盘图标）** | macOS only，两个非 mac 平台既没有该事件也没有托盘 |
| **真实桌面上的透明表现** | 无头环境没有合成器，见 §4 |
| **安装流程本身（Linux）** | deb 是打出来了、解包后也能跑，但**从没 `dpkg -i` 装过**（那需要 root）。`postinst` 里那段 chrome-sandbox 权限判断、`update-alternatives` 建 `/usr/bin/abx`、AppArmor profile，都只在源码层面读过，没实跑过 |
| **AppImage 直接运行** | 只验到「可执行位在、`.desktop` 里的 Exec 是 `AppRun --no-sandbox`」；本机没有 FUSE，**没双击过、也没直接执行过整包** |
| **`decideCellHost()` 接进会话路径** | 判定、候选表、失败文案都已落地并有单测，但 `abx open` 目前**还没有调用它**：探一次要起一个容器，而那会改到 `e2e-persist.sh` 里「这一次 `docker run` 有几条」那组断言的语义。当前的实际行为是「照配置走，`--cell-host` 可覆盖」，绑定那一半（`bindHostCandidates()`）已经在用 |
| **CI 流水线（Linux 打包）** | `package-linux.yml` 是照本机实测值写的，产出断言在本机对真实产物跑通过；但**这条 workflow 还没在 GitHub runner 上跑过一次** |

---

## 6. 归属

如果将来按 [`../README.md`](../README.md) 的规划开出 `platform/` 簇
（macOS 打包与宿主适配），**本文整体迁到那一簇**，本文的链接同步改写。

