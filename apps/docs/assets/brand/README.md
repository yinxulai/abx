# 品牌资源

所有位图（打包 png / ico、托盘、文档导出）都由 **一个矢量源** 派生，不要手改 png。

```powershell
pnpm icons
```

脚本：`scripts/generate-icons.mjs`（只用机器上已有的 `google-chrome --headless` 与 ImageMagick `convert`，不依赖 `sharp`）。

## 标志

一个**填满的圆角方块**，只在右上角开一道斜口。渐变 `#3FD9C6 → #0E8C80`。

选它不是因为好看，是因为四条硬约束：

- **16px 下还得像一个东西。** 托盘图标只有 256 个像素，任何细线、镂空、多笔画都会糊成噪点。
  实心块是这个尺寸下唯一还完整的形状——缩到 16px，它仍然是一块有明确轮廓的色块。
- **那道开角就是产品本身。** 方框代表隔离的边界，缺掉的一角是「传递窗」：东西只从这一个口子进出。
  标志要能一句话说清产品在做什么，不需要配文案。
- **颜色就是界面的点缀色。** `#3FD9C6` / `#0E8C80` 与 `packages/console` 的 accent 是同一对，
  标志、界面、文档不会各说各话。
- **能当纯白蒙版用。** 整套几何不依赖颜色——托盘模板图就是把同一张形状涂成纯白、只留 alpha
  （macOS 的模板图由系统着色，RGB 根本不参与）。换成单色白 / 单色黑也只有这一种形状。

## 单一矢量源

| 文件 | 角色 |
| --- | --- |
| `packages/console/public/icon.svg` | **唯一真源**。控制台 favicon 与上述所有位图的来源。 |
| `apps/docs/assets/brand/icon.svg` | 真源的副本，供本目录自解释 / 外部取用；脚本每次运行都会重写。 |
| `apps/docs/public/logo.svg`、`favicon.svg` | 文档站直接引用；同样是真源的副本，逐字节一致。 |
| `apps/www/public/icon.svg` | 官网的图标位（Vite `public/`，构建时原样拷到站点根）。 |
| `apps/docs/public/icon-256.png` | 文档站引用的位图，直接拷 `png/icon-256.png`，不另渲一份。 |

## 导出方式

**不需要扫墨迹框。** 与 osw 的同名脚本不同，abx 的标志**自带留白**：路径画在 `16…240`
之间，加 6 单位描边（两边各 3）后墨迹落在 `13…243`，即 256 画布四周各留约 5.1%。
所以各尺寸直接等比缩放即可，没有那套「先量墨迹、再 contain-fit」的步骤。
唯一的例外是开发版（右下角要腾出圆点的位置），那里才从已渲染的 1024 里量一次，
而不是把 `13` 写死成常量。

小尺寸靠**超采样**保住边缘：≤ 64px 按 8× 渲染再 `Lanczos` 降采样，≤ 512px 给 4×，
≥ 1024px 给 2×；且**渲染边长不低于 256**（Chrome 在小于约 140px 的窗口下会给出内容坏掉的
截图——尺寸对、内容被压扁，看不见的那种坏）。ICO 的每一帧都按自己的目标尺寸重新光栅化，
不是把 1024 缩下去。

## 产物与用途

### `apps/app/build/`（打包 / 运行时，被 Electron 直接引用）

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `icon.png` | 1024² 彩色 | `electron-builder` 应用图标（Windows / Linux）；`main.ts` 的窗口与 Linux 托盘图标 |
| `icon-mac.png` | 1024² 彩色 | macOS 应用图标（`mac.icon`） |
| `icon.ico` | 7 档 16/24/32/48/64/128/256 | Windows 可执行文件 / 安装包图标 |
| `trayTemplate.png` | 16² 纯白 + alpha | 托盘蒙版（1×） |
| `trayTemplate@2x.png` | 32² 纯白 + alpha | 托盘蒙版（2×）；`createFromPath` 会自动认这个 `@2x` 兄弟 |
| `tray-icon-win.png` | 48² 纯白 + alpha | **Windows 专用**，见下 |
| `trayTemplate-dev.png` / `@2x` / `tray-icon-dev-win.png` | 同上 | 开发版：标志右下角多一颗圆点 |

### 为什么托盘有 Windows 专用的一张

托盘是唯一「必定被系统按屏幕 DPI 重新取样」的地方，而两个平台要的信息不一样：

- **macOS / Linux**：走真正的多倍率。`nativeImage.createFromPath('trayTemplate.png')`
  会自己带上同目录的 `trayTemplate@2x.png`（本机实测返回 `[1, 2]`），系统按显示倍率挑。
- **Windows**：多倍率是假的。Electron 在 Windows 上走
  `NativeImage::GetHICON(GetSystemMetrics(SM_CXSMICON))`，而**非 `.ico` 来源**的
  `GetHICON` 会丢弃 size 参数、只取 1× 那一档（`AsBitmap()`）。挂上去的 2× 永远读不到，
  系统只会拿 16² 放大到 24/32px，于是糊。所以 Windows 单独吃一张 48² 的大图当「1×」。

> 运行时**禁止**再调用 `image.resize()`：它只会把某一个倍率重新取样一次，正好是要避免的糊。

### 开发版托盘标记

开发版与正式版同时驻留托盘时，靠**标志右下角的一颗独立圆点**区分：标志缩进左上角
约 0.8 的区域，圆点落在右下角，两者之间留约 0.1 框宽（16px 下 ≈ 1.7px）的缝。

此前想过「把标志的斜角切掉一块」，但 16px 下缺口会和标志自己那道开角糊在一起，
看起来像图没画完。现在是满血标志 + 一颗点，两个尺寸下都能一眼分清。

> 注意：`trayTemplate-dev.png` 不以 `Template` 结尾，Electron 那套「文件名以 `Template`
> 结尾就当模板图」的自动判断对它无效。将来若在 macOS 上接开发版托盘，得显式
> `image.setTemplateImage(true)`，否则系统会把它当彩色图画出来。

### `apps/docs/assets/brand/png/`（文档 / 物料导出，不参与打包）

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `icon-1024/512/256/128/64/32.png` | 各档 | 通用位图：README、官网、商店页 |
| `icon-mono-white-1024.png` | 1024² | 单色白（深色底上的反白用法） |
| `icon-mono-black-1024.png` | 1024² | 单色黑（浅色底、印刷） |
| `icon-on-dark-1024.png` | 1024² | 深色底板版本（底色是设计体系的深色 `--bg` `#191A1C`） |
| `social-preview.png` | 1280×640 | 社交 / 仓库预览图 |

## 防漂移

`packages/console/source/brand-assets.test.ts` 会逐字节读这些产物（自带一个只认 8 位 RGBA、
非隔行的 PNG 解码器），校验：文件存在且尺寸精确、ICO 真的含 7 档且每帧 IHDR 对得上、
托盘蒙版的每个不透明像素都是纯白、开发版是真的两块（标志 + 右下角的点）且与正式版不同字节、
所有派生图共用同一个轮廓、单色档与深色底板没有混色。

改了标志就改真源、跑 `pnpm icons`、再跑 `pnpm test`——三件事都做完才算改完。
