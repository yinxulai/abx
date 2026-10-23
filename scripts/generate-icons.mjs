#!/usr/bin/env node
/**
 * 生成全部位图产物 —— 一个矢量源，所有派生图。
 *
 * 唯一矢量源是 `packages/console/public/icon.svg`：托盘、打包图标、站点 favicon、
 * 文档与宣发导出**全部**由它派生，不存在「第二份几何」。想改标志就改那一个文件，
 * 然后跑 `pnpm icons` 重新生成；**任何位图都不许手改**，这个脚本每次运行都会重写它们。
 *
 * ## 为什么留白不量墨迹框
 *
 * osw 的同名脚本要先扫一遍 alpha 求出「含描边的墨迹框」，再把墨迹 contain-fit 进画布——
 * 因为它的标志本身没有内边距。abx 的标志**自带**留白：路径画在 16…240 之间，加 6 单位
 * 描边（两边各 3）后墨迹落在 13…243，也就是 256 画布四周各留 5.1%。
 * 所以各尺寸直接等比缩放即可，不需要那套扫描与 contain-fit。
 * 唯一的例外是开发版（右下角要腾出圆点的位置），那里才真的需要知道墨迹落在哪，
 * 于是脚本会**从已渲染的 1024 里量一次**（`measureInk`），而不是把 13 写死成常量。
 *
 * ## 怎么渲染
 *
 * 本仓库没有 `sharp`（也不打算为图标引一个），用的是机器上已有的两件工具：
 * `google-chrome --headless` 光栅化 SVG，`convert` 降采样与落盘。
 *
 * 每个尺寸按 8×（≤ 64px）或 4×（≤ 512px）或 2×（≥ 1024px）渲染再 `Lanczos` 降采样，
 * 并且**渲染边长不低于 256**（见 `MIN_RENDER_SIZE`：Chrome 在小窗口下会给出内容坏掉的截图）。
 * 小尺寸必须超采样：16px 的托盘图只有 256 个像素，边缘那圈反锯齿是靠多采样平均出来的，
 * 直接按 16px 光栅化会得到一圈忽明忽暗的锯齿。大尺寸反过来——1024 那两张再乘 4
 * 就是 4096² 的截屏，Skia 直接按目标尺寸光栅化的覆盖率精度已经足够，多出来的只有耗时。
 *
 * 坐标系只有两套，别把它们搞混（搞混过一次，标志缩在画布一角）：
 *   - **用户空间**（`viewBox`）：一切构图都以它为单位，默认就是源的 `viewBox`；
 *   - **成品像素**：`width` / `height` 是成品的像素尺寸。
 * SVG 的 `width`/`height` 声明的是「成品像素 × 超采样倍数」，浏览器于是按这个尺寸画，
 * 而降采样再把它拉回成品像素——两边必须用同一个 `supersample`。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** 唯一矢量源。 */
const SOURCE_SVG = resolve(repoRoot, 'packages/console/public/icon.svg')
/** 打包与运行时产物：`apps/app/source/main.ts` 与 electron-builder 都按文件名引用这里。 */
const BUILD_DIR = resolve(repoRoot, 'apps/app/build')
/** 文档 / 宣发导出。 */
const BRAND_DIR = resolve(repoRoot, 'apps/docs/assets/brand')
const BRAND_PNG_DIR = resolve(BRAND_DIR, 'png')
/** 站点直接吃的三份：`apps/docs/clarify.ts` 的 logo / favicon，以及文档站那张 256。 */
const DOCS_PUBLIC_DIR = resolve(repoRoot, 'apps/docs/public')
/** 官网自己的图标位（Vite 的 `public/`，构建时原样拷到站点根）。 */
const WWW_PUBLIC_DIR = resolve(repoRoot, 'apps/www/public')

/** Windows 的 ico 惯例档位；256 是 Vista 之后的上限，再大没有意义。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 托盘：macOS 与 Linux 共用的一份逻辑尺寸 16，实际出 1× 与 2× 两档位图。
 *
 * 文件名不是随便起的——`nativeImage.createFromPath()` 会**自己去找同目录的 `@2x` 兄弟**：
 * 只传 `trayTemplate.png` 时，返回的 NativeImage 上挂着 [1, 2] 两个倍率（本机实测）。
 * 所以 `apps/app/source/main.ts` 里那一行虽然只写了 16²，32² 那份同样是活的，别删。
 */
const TRAY_BASE_SIZE = 16
const TRAY_SCALES = [1, 2]

/**
 * Windows 专用的一张：48²，当「1×」交给系统。
 *
 * Windows 的多倍率是假的。Electron 在 Windows 上走
 * `NativeImage::GetHICON(GetSystemMetrics(SM_CXSMICON))`，而**非 `.ico` 来源**的
 * `GetHICON` 会丢弃 size 参数、只取 1× 那一档位图（`AsBitmap()`）。挂上去的 2× 永远
 * 读不到，系统只会拿 16² 放大到 24/32px，于是糊。解法就是让 1× 本身足够大。
 */
const TRAY_WINDOWS_SIZE = 48

/** 文档导出的通用尺寸档（1024 那张在打包图标那一步顺带出，这里不重复）。 */
const BRAND_SIZES = [512, 256, 128, 64, 32]
/** 深色底板用设计体系里那个深色 `--bg`（`design-system.md` §2），不另挑一个黑。 */
const DARK_BACKGROUND = '#191A1C'
/** GitHub 仓库的 social preview 固定 1280×640；标志占画布高度的这个比例。 */
const SOCIAL_PREVIEW = { width: 1280, height: 640, markRatio: 0.64 }

/**
 * 开发版标记：标志右下角一颗圆点。所有数字都以**标志框**（源的 `viewBox`）为单位。
 *
 * 上一版的做法是「把标志的斜角切掉一块」，但 16px 下缺口会和标志自己那个开着的角
 * （传递窗）糊在一起，看起来像图没画完。现在改成**满血标志 + 右下角一颗独立圆点**。
 *
 * 标志是**实心方块**，右下角是填满的，所以圆点必须占一块自己的地方：标志缩进左上角的
 * `region` 方框，圆点落在右下角的空处。两者之间留出约 0.1 框宽的缝——16px 下 ≈ 1.7px，
 * 看得出是两颗东西（`brand-assets.test.ts` 会按像素验这一点）。
 */
const DEV_BADGE = { region: 0.8, x: 0.86, y: 0.86, radius: 0.11, fill: '#fff' }

/** 墨迹扫描的阈值：边缘反锯齿会产生一大片 1/255 的近透明像素，取 0 会把框撑到整张画布。 */
const INK_THRESHOLD = 12

/** 单色档要替换掉的颜色引用（渐变 ID 怎么写都行，凡是 `url(#…)` 一律换掉）。 */
const PAINT_REFERENCE = /url\(#[^)]*\)/g

const toPosix = (file) => file.slice(repoRoot.length + 1).replaceAll('\\', '/')

// ---------------------------------------------------------------- 外部工具

/** 找一台能用的 Chrome/Chromium。`ABX_CHROME` 可以指向别处（别的发行版或 CI）。 */
function resolveChrome() {
  const candidates = [process.env.ABX_CHROME, 'google-chrome', 'chromium', 'chromium-browser'].filter(
    (name) => typeof name === 'string' && name !== '',
  )
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // 没装这个候选，试下一个。
    }
  }
  throw new Error(`找不到 Chrome（试过：${candidates.join(' / ')}），可以用 ABX_CHROME 指定路径`)
}

/** ImageMagick 6 是 `convert`，7 之后是 `magick`。两个都认。 */
function resolveImagemagick() {
  for (const prefix of [['convert'], ['magick']]) {
    try {
      execFileSync(prefix[0], ['-version'], { stdio: 'ignore' })
      return prefix
    } catch {
      // 同上。
    }
  }
  throw new Error('找不到 ImageMagick（convert / magick 都没有）')
}

const chrome = resolveChrome()
const imagemagick = resolveImagemagick()

/** 跑一条外部命令。图标最大也就几 MB，缓冲给足免得被截断。 */
function run(command, args) {
  return execFileSync(command, args, { maxBuffer: 256 * 1024 * 1024 })
}

/** `convert` / `magick` 的调用：前缀 + 参数。 */
function imagemagickRun(args) {
  return run(imagemagick[0], [...imagemagick.slice(1), ...args])
}

// ---------------------------------------------------------------- SVG

/**
 * 拆出 `viewBox` 与 `<svg>` 内部的内容。
 *
 * 只做这一层字符串拆分，不解析 DOM：所有输出都复刻用户空间的原始坐标，
 * 改标志的人随手写什么都行（多几个 `<defs>`、换个渐变 ID 都不影响）。
 */
function parseSource(source) {
  const viewBox = /\bviewBox="([^"]+)"/.exec(source)?.[1]
  if (viewBox === undefined) throw new Error('icon.svg 缺少 viewBox，无法推算构图')
  const numbers = viewBox.trim().split(/[\s,]+/).map(Number)
  if (numbers.length !== 4 || numbers.some((value) => Number.isNaN(value))) {
    throw new Error(`icon.svg 的 viewBox 不是四个数字：${viewBox}`)
  }
  const open = source.indexOf('<svg')
  const inner = source.slice(source.indexOf('>', open) + 1, source.lastIndexOf('</svg>'))
  return { box: { minX: numbers[0], minY: numbers[1], width: numbers[2], height: numbers[3] }, inner }
}

/** 6 位小数足够表达任何一个变换，再多只会让生成的 SVG 难读。 */
function round(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * 组装一张待光栅化的 SVG。
 *
 * 构图全在用户空间里算：`mark` 把源内容摆进 `viewBox`，`badge` 是同一空间里的圆点。
 * 输出的像素尺寸由 `pixels`（成品）与 `supersample`（倍数）决定，与用户空间无关——
 * 这样「换个尺寸出图」只是换两个数，构图一个字都不用动。
 *
 * @param {object} options
 * @param {{minX:number,minY:number,width:number,height:number}} options.box 源的 viewBox
 * @param {string} options.inner        源里 `<svg>` 的内容
 * @param {number} options.viewBoxWidth  用户空间宽（默认取 `box`）
 * @param {number} options.viewBoxHeight 用户空间高（默认取 `box`）
 * @param {{width:number,height:number}} options.pixels 成品像素尺寸
 * @param {number} options.supersample  渲染倍数
 * @param {{x:number,y:number,scale:number}} options.mark 标志的摆放变换（用户空间）
 * @param {string} [options.paint]      单色替换：把渐变引用换成这个颜色
 * @param {string} [options.background] 底色，默认透明
 * @param {{x:number,y:number,radius:number,fill:string}} [options.badge] 开发版圆点（用户空间）
 * @param {{x:number,y:number}} [options.shift] 整体平移（用户空间），给合并包围盒的居中用
 */
function composeSvg(options) {
  const { box, inner, pixels, supersample, mark, paint, background, badge } = options
  const viewBoxWidth = options.viewBoxWidth ?? box.width
  const viewBoxHeight = options.viewBoxHeight ?? box.height
  const shift = options.shift ?? { x: 0, y: 0 }
  const content = paint === undefined ? inner : inner.replaceAll(PAINT_REFERENCE, paint)
  const [rx, ry] = [mark.x - box.minX * mark.scale, mark.y - box.minY * mark.scale]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.width * supersample}" height="${pixels.height * supersample}"`,
    ` viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}">`,
    background === undefined
      ? ''
      : `<rect x="0" y="0" width="${viewBoxWidth}" height="${viewBoxHeight}" fill="${background}"/>`,
    `<g transform="translate(${round(shift.x)} ${round(shift.y)})">`,
    `<g transform="translate(${round(rx)} ${round(ry)}) scale(${round(mark.scale)})">${content}</g>`,
    badge === undefined
      ? ''
      : `<circle cx="${round(badge.x)}" cy="${round(badge.y)}" r="${round(badge.radius)}" fill="${badge.fill}"/>`,
    '</g>',
    '</svg>',
  ].join('')
}

// ---------------------------------------------------------------- 光栅化

/**
 * 最小渲染边长。**这个是实测出来的下限，不是拍脑袋定的。**
 *
 * `--window-size` 小于 ~140px 时，Chrome 给出的截图尺寸仍然对，内容却是坏的：
 * 标志被压成又扁又矮的一条（16px 托盘那张量出来墨迹 14×6，正确的应该是 14×14）。
 * 逐档实测：136 坏、144 好；128 坏、256 好。截图大小对不上是能看见的，这个坏法看不见——
 * 所以小尺寸一律抬到 256 再降采样，多出来的采样也正好让 16px 的边缘更干净。
 */
const MIN_RENDER_SIZE = 256

/** 渲染倍数：小图多超采样（≤ 64px 给 8×），大图少给（≥ 1024px 给 2×），再兜住上面那条下限。 */
function renderScale(pixels) {
  const bySize = pixels <= 64 ? 8 : pixels <= 512 ? 4 : 2
  return Math.max(bySize, Math.ceil(MIN_RENDER_SIZE / pixels))
}

/**
 * 用 Chrome 把一张 SVG 光栅化成 PNG。
 *
 * `--default-background-color=00000000` 是透明底的关键：不给这个参数，Chrome 会铺一层
 * 不透明白底，托盘蒙版与图标就都没有 alpha 了。
 *
 * 截出来的尺寸**当场核对**：`-resize WxH!` 会把任何尺寸差都「修好」——包括不该修的，
 * 比如哪天 Chrome 改了行为、给回一张别的尺寸，那就会静默产出被拉变形的标志。
 */
function rasterize(svgText, pixels, scale, scratch) {
  const tag = `${pixels.width}x${pixels.height}`
  const svgPath = join(scratch, `${tag}.svg`)
  const pngPath = join(scratch, `${tag}-${scale}x.png`)
  const expected = `${pixels.width * scale}x${pixels.height * scale}`
  writeFileSync(svgPath, svgText)
  run(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    // 无头截屏不需要沙箱，容器里（以 root 跑）没有它反而会起不来。
    '--no-sandbox',
    `--user-data-dir=${join(scratch, 'profile')}`,
    '--default-background-color=00000000',
    `--window-size=${expected}`,
    `--screenshot=${pngPath}`,
    `file://${svgPath}`,
  ])
  const actual = imagemagickRun([pngPath, '-format', '%wx%h', 'info:']).toString()
  if (actual !== expected) {
    throw new Error(`Chrome 截出来是 ${actual}，期望 ${expected}（${toPosix(svgPath)}）`)
  }
  return pngPath
}

/**
 * 超采样图 → 成品：Lanczos 降采样，必要时把 RGB 压成纯白，落盘为 8 位 RGBA。
 *
 * `-channel RGB -colorize 100` 是托盘蒙版的必要一步：降采样会把边缘像素的 RGB
 * 与透明像素（RGB 是 0,0,0）平均成灰色，而那些像素的 alpha 并不是 0。
 * macOS 的模板图只看 alpha、Windows/Linux 的托盘却会把这层灰画出来——
 * 所以这里显式把 RGB 全部改写成纯白，只留 alpha 表达形状。
 *
 * `-define png:color-type=6` 加 `PNG32:` 双保险把输出钉成 8 位 RGBA：规格统一，
 * 读它的人就不用猜是调色板还是 16 位（`brand-assets.test.ts` 正是这么读的）。
 */
function writeDownscaled(source, target, pixels, flattenWhite) {
  const args = [source, '-filter', 'Lanczos', '-resize', `${pixels.width}x${pixels.height}!`]
  if (flattenWhite) args.push('-channel', 'RGB', '-fill', 'white', '-colorize', '100', '+channel')
  args.push('-strip', '-define', 'png:color-type=6', `PNG32:${target}`)
  imagemagickRun(args)
}

/**
 * 量出「含描边的墨迹」包围盒（用户空间坐标）。
 *
 * `-alpha extract` 把 alpha 单独取出来，`gray:-` 是不带任何头的原始灰度字节流，
 * 所以不需要图片解码器：按 `y * 宽 + x` 索引扫一遍即可。
 * 入参是**已经渲染好的位图**（拿 1024 那张来量），不是路径的 `d`——
 * 标志是靠 `stroke-width` 喂胖的，只看路径顶点会算出偏小一圈的框。
 */
function measureInk(pngPath, pixels, box) {
  const alpha = imagemagickRun([pngPath, '-alpha', 'extract', '-depth', '8', 'gray:-'])
  if (alpha.length !== pixels * pixels) {
    throw new Error(`alpha 通道读出来是 ${alpha.length} 字节，期望 ${pixels * pixels}`)
  }
  let minX = pixels
  let minY = pixels
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < pixels; y += 1) {
    for (let x = 0; x < pixels; x += 1) {
      if (alpha[y * pixels + x] <= INK_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('标志渲染后完全透明，检查 fill / stroke 是否指向了不存在的渐变')
  const unit = box.width / pixels
  return { x: box.minX + minX * unit, y: box.minY + minY * unit, w: (maxX - minX + 1) * unit, h: (maxY - minY + 1) * unit }
}

// ---------------------------------------------------------------- ICO

/**
 * 打出 ICO 容器。
 *
 * Vista 之后每一帧都可以直接是一张 PNG，不需要自己写 BMP 与调色板；
 * 目录项里 256 用 0 表示（一个字节放不下 256）。
 */
function packIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(frames.length, 4)

  const directory = Buffer.alloc(16 * frames.length)
  let offset = header.length + directory.length
  frames.forEach((frame, index) => {
    const at = index * 16
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, at)
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板颜色数：真彩色写 0
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(frame.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += frame.png.length
  })

  return Buffer.concat([header, directory, ...frames.map((frame) => frame.png)])
}

// ---------------------------------------------------------------- 主流程

function main() {
  const source = readFileSync(SOURCE_SVG, 'utf8')
  const { box, inner } = parseSource(source)
  /** 标志的摆放变换：铺满整张画布（留白由标志自己带）。 */
  const full = { x: 0, y: 0, scale: 1 }

  for (const dir of [BUILD_DIR, BRAND_PNG_DIR, DOCS_PUBLIC_DIR, WWW_PUBLIC_DIR]) mkdirSync(dir, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'abx-icons-'))

  const written = []
  /** 渲染一次、落盘到一个或多个目标。同一份像素要在多处出现时（icon / icon-mac）只渲染一次。 */
  const emit = (targets, options) => {
    const files = Array.isArray(targets) ? targets : [targets]
    const pixels = { width: options.width, height: options.height ?? options.width }
    const scale = renderScale(Math.max(pixels.width, pixels.height))
    const svg = composeSvg({
      box,
      inner,
      viewBoxWidth: options.viewBoxWidth,
      viewBoxHeight: options.viewBoxHeight,
      pixels,
      supersample: scale,
      mark: options.mark,
      paint: options.paint,
      background: options.background,
      badge: options.badge,
      shift: options.shift,
    })
    const raw = rasterize(svg, pixels, scale, scratch)
    writeDownscaled(raw, files[0], pixels, options.paint === '#fff')
    for (const also of files.slice(1)) copyFileSync(files[0], also)
    for (const file of files) written.push({ file, note: options.note })
  }

  try {
    // ── 打包图标。icon.png 与 icon-mac.png 目前是同一张：Linux 的 .desktop/AppImage
    // 与 macOS 的 .icns 都要彩色方图，构图没有差别。留着两个名字，是因为
    // `electron-builder.config.cjs` 里 `linux.icon` 与 `mac.icon` 各指一份——
    // 将来 macOS 若要换个画法（比如补一层底），改这里一处即可。
    emit([join(BUILD_DIR, 'icon.png'), join(BUILD_DIR, 'icon-mac.png'), join(BRAND_PNG_DIR, 'icon-1024.png')], {
      width: 1024,
      mark: full,
      note: '打包主图标 / macOS / 文档导出',
    })

    // ── 墨迹框：从刚出炉的 1024 里量一次，只服务开发版构图（见文件头的说明）。
    const ink = measureInk(join(BUILD_DIR, 'icon.png'), 1024, box)

    // ── ICO：每一帧都是一张独立位图，按各自的目标尺寸重新光栅化（不是把 1024 缩下去）。
    const frames = ICO_SIZES.map((size) => {
      const target = join(scratch, `ico-${size}.png`)
      const pixels = { width: size, height: size }
      const scale = renderScale(size)
      const svg = composeSvg({ box, inner, pixels, supersample: scale, mark: full })
      writeDownscaled(rasterize(svg, pixels, scale, scratch), target, pixels, false)
      return { size, png: readFileSync(target) }
    })
    const ico = join(BUILD_DIR, 'icon.ico')
    writeFileSync(ico, packIco(frames))
    written.push({ file: ico, note: `${ICO_SIZES.length} 档：${ICO_SIZES.join('/')}` })

    // ── 托盘：纯白蒙版。彩色在这里没有意义——macOS 的模板图由系统接管着色，
    // 我们给的 RGB 根本不会被采用；Linux 那边 `main.ts` 用的是彩色 `icon.png`。
    for (const scale of TRAY_SCALES) {
      const suffix = scale === 1 ? '' : `@${scale}x`
      emit(join(BUILD_DIR, `trayTemplate${suffix}.png`), {
        width: TRAY_BASE_SIZE * scale,
        mark: full,
        paint: '#fff',
        note: '托盘蒙版',
      })
    }
    emit(join(BUILD_DIR, 'tray-icon-win.png'), {
      width: TRAY_WINDOWS_SIZE,
      mark: full,
      paint: '#fff',
      note: 'Windows 托盘（单张当 1×）',
    })

    // ── 开发版：标志缩进左上角，右下角一颗圆点，再按合并包围盒居中。
    const region = DEV_BADGE.region * box.width
    const devScale = Math.min(region / box.width, region / box.height)
    const devMark = {
      x: region / 2 - devScale * (box.minX + box.width / 2),
      y: region / 2 - devScale * (box.minY + box.height / 2),
      scale: devScale,
    }
    const dot = {
      x: DEV_BADGE.x * box.width,
      y: DEV_BADGE.y * box.height,
      radius: DEV_BADGE.radius * box.width,
      fill: DEV_BADGE.fill,
    }
    // 「缩小后的标志墨迹」与「圆点」合起来的包围盒，按图心拉回画布中央，
    // 否则圆点会把整个图形拽向右下、看起来偏一边。
    const left = Math.min(devMark.x + devScale * ink.x, dot.x - dot.radius)
    const right = Math.max(devMark.x + devScale * (ink.x + ink.w), dot.x + dot.radius)
    const top = Math.min(devMark.y + devScale * ink.y, dot.y - dot.radius)
    const bottom = Math.max(devMark.y + devScale * (ink.y + ink.h), dot.y + dot.radius)
    const shift = { x: box.width / 2 - (left + right) / 2, y: box.height / 2 - (top + bottom) / 2 }

    for (const scale of TRAY_SCALES) {
      const suffix = scale === 1 ? '' : `@${scale}x`
      emit(join(BUILD_DIR, `trayTemplate-dev${suffix}.png`), {
        width: TRAY_BASE_SIZE * scale,
        mark: devMark,
        paint: '#fff',
        badge: dot,
        shift,
        note: '托盘蒙版 · 开发版（右下角圆点）',
      })
    }
    emit(join(BUILD_DIR, 'tray-icon-dev-win.png'), {
      width: TRAY_WINDOWS_SIZE,
      mark: devMark,
      paint: '#fff',
      badge: dot,
      shift,
      note: 'Windows 托盘 · 开发版',
    })

    // ── 文档 / 宣发导出。
    for (const size of BRAND_SIZES) emit(join(BRAND_PNG_DIR, `icon-${size}.png`), { width: size, mark: full })
    for (const paint of ['#fff', '#000']) {
      const name = paint === '#fff' ? 'icon-mono-white' : 'icon-mono-black'
      emit(join(BRAND_PNG_DIR, `${name}-1024.png`), { width: 1024, mark: full, paint })
    }
    emit(join(BRAND_PNG_DIR, 'icon-on-dark-1024.png'), { width: 1024, mark: full, background: DARK_BACKGROUND })

    // social preview：画布是 1280×640 的像素空间（2:1），标志按高度比例缩放居中。
    const socialScale = (SOCIAL_PREVIEW.markRatio * SOCIAL_PREVIEW.height) / box.height
    const center = { width: SOCIAL_PREVIEW.width, height: SOCIAL_PREVIEW.height }
    emit(join(BRAND_PNG_DIR, 'social-preview.png'), {
      ...center,
      viewBoxWidth: center.width,
      viewBoxHeight: center.height,
      background: DARK_BACKGROUND,
      mark: {
        x: center.width / 2 - socialScale * (box.minX + box.width / 2),
        y: center.height / 2 - socialScale * (box.minY + box.height / 2),
        scale: socialScale,
      },
    })

    // ── 站点与文档直接引用的那几份：矢量源原样一份，外加一张 256 位图。
    for (const file of [
      join(BRAND_DIR, 'icon.svg'),
      join(DOCS_PUBLIC_DIR, 'logo.svg'),
      join(DOCS_PUBLIC_DIR, 'favicon.svg'),
      join(WWW_PUBLIC_DIR, 'icon.svg'),
    ]) {
      writeFileSync(file, source)
      written.push({ file, note: '矢量源副本' })
    }
    copyFileSync(join(BRAND_PNG_DIR, 'icon-256.png'), join(DOCS_PUBLIC_DIR, 'icon-256.png'))
    written.push({ file: join(DOCS_PUBLIC_DIR, 'icon-256.png'), note: '文档站引用的 256' })

    for (const { file, note } of written) {
      const { size } = statSync(file)
      console.log(`${toPosix(file)}  ${(size / 1024).toFixed(1)} KB${note === undefined ? '' : `  (${note})`}`)
    }
    console.log(
      `\n墨迹框 ${ink.w.toFixed(1)} × ${ink.h.toFixed(1)}（用户空间），四周留白 ` +
        `${(((box.width - ink.w) / box.width) * 100).toFixed(1)}%，共 ${written.length} 个产物`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

main()
