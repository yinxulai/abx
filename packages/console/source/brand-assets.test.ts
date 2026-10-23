/**
 * 品牌产物的对账：一个矢量源，所有派生图。
 *
 * 位图是 `scripts/generate-icons.mjs` **生成**的，所以最容易坏的方式不是「代码写错」，
 * 而是「漂移」：有人手改了一张 png、真源换了形状却没重新生成、开发版忘了加那颗圆点、
 * 托盘的模板图混进了彩色像素、某个尺寸少了一档。这些错误没有一个会让构建失败——
 * 只会让托盘里出现一张糊图、一个隐形图标，或者打包时静默少一个文件。
 *
 * 这里自己解 PNG（`node:zlib` + 手工反过滤）：仓库里没有图像库，也不打算为图标引一个
 * （见 AGENTS.md 的依赖选型）。生成器把输出钉成**8 位 RGBA、非隔行**（脚本里的 `PNG32:`），
 * 所以解码器只认这一种，遇到别的直接抛错——不是「凑合读」，而是「规格变了，这里要跟着改」。
 *
 * 尺寸、轮廓、某一像素的色相这三样合起来**仍然漏得掉一种漂移**：一张几何全对、
 * 轮廓全对、连采样点颜色都对，但内容被人手动涂改过的 png。所以最后一组断言不看图，
 * 只看指纹：`brand-assets.hash.json` 里存着生成器写下的每一个产物的 sha256，
 * 对不上就是「这张图不是生成器产出的那一张」。清单由 `pnpm icons` 每次重写
 * （它本身就是本次运行的产物），所以改了真源就重跑那一条命令，不需要手编清单。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------- PNG

interface Raster {
  readonly width: number
  readonly height: number
  /** 每像素 4 字节：R、G、B、A。 */
  readonly rgba: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = 4

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** 逐行反过滤。五种过滤器都要认：ImageMagick 写 PNG 时是按行自适应挑的。 */
function unfilter(raw: Buffer, width: number, height: number): Buffer {
  const stride = width * CHANNELS
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const target = out.subarray(y * stride, (y + 1) * stride)
    const previous = y === 0 ? undefined : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x < CHANNELS ? 0 : target[x - CHANNELS]
      const up = previous === undefined ? 0 : previous[x]
      const upLeft = previous === undefined || x < CHANNELS ? 0 : previous[x - CHANNELS]
      const value = line[x]
      if (filter === 0) target[x] = value
      else if (filter === 1) target[x] = (value + left) & 0xff
      else if (filter === 2) target[x] = (value + up) & 0xff
      else if (filter === 3) target[x] = (value + ((left + up) >> 1)) & 0xff
      else if (filter === 4) target[x] = (value + paeth(left, up, upLeft)) & 0xff
      else throw new Error(`未知的 PNG 行过滤器 ${filter}`)
    }
  }
  return out
}

/** 解析一张 8 位 RGBA、非隔行的 PNG。别的规格一律报错，不静默当成能读。 */
function decodePng(file: string): Raster {
  const bytes = readFileSync(file)
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`${file} 不是 PNG`)
  const header = bytes.subarray(16, 29)
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const interlace = header[12]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${file}：bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}，只认 8 位 RGBA 非隔行`)
  }

  const chunks: Buffer[] = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') break
  }
  if (chunks.length === 0) throw new Error(`${file} 里没有 IDAT`)
  return { width, height, rgba: unfilter(inflateSync(Buffer.concat(chunks)), width, height) }
}

/** 只读 IHDR，不 inflate：只关心尺寸时不必解整张图（ICO 里那些内嵌帧用得上）。 */
function sizeOfPng(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const rasterOf = (file: string): Raster => decodePng(fileURLToPath(new URL(file, import.meta.url)))
const bytesOf = (file: string): Buffer => readFileSync(new URL(file, import.meta.url))
const textOf = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')

const pixelAt = (raster: Raster, x: number, y: number): readonly number[] => {
  const at = (y * raster.width + x) * CHANNELS
  return [raster.rgba[at], raster.rgba[at + 1], raster.rgba[at + 2], raster.rgba[at + 3]]
}

/** 墨迹阈值与生成器里那个是同一个：不取 0，否则一片 1/255 的反锯齿像素会把框撑到整张画布。 */
const INK = 12

/**
 * 连通性的阈值取「过半覆盖」，比 `INK` 严得多。
 *
 * 16px 的开发版里，标志与圆点之间只有约 1.7px 的缝，而 `INK` 那一档会把缝里
 * 极淡的反锯齿像素也算成墨迹——8 连通下两块就粘成一块了，可眼睛看到的明明是两颗。
 * 只留实体（过半）才是「这块是不是独立的一坨」该用的判据。
 */
const SOLID = 128
const isSolid = (raster: Raster, x: number, y: number): boolean => raster.rgba[(y * raster.width + x) * CHANNELS + 3] > SOLID

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 图形本身的包围盒。
 *
 * `background` 为 `undefined` 时按 alpha 算（透明底的图）；给了底色则按「与底色差得够多」算
 * ——深色底板那两张整幅不透明，alpha 全是 255，用 alpha 量等于量整张画布。
 * 差值的阈值与 `INK` 取同一个数，是为了让两种量法**灵敏度一致**：
 * 否则「差一个 1/255」会把反锯齿的淡边也算进来，同一张图换个量法就大了一圈。
 */
function shapeBox(raster: Raster, background: readonly number[] | undefined): Box {
  let minX = raster.width
  let minY = raster.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const [red, green, blue, alpha] = pixelAt(raster, x, y)
      const distance =
        background === undefined
          ? 255
          : Math.max(Math.abs(red - background[0]), Math.abs(green - background[1]), Math.abs(blue - background[2]))
      if (alpha <= INK || distance <= INK) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('这张图找不到图形')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

interface Blot {
  readonly size: number
  readonly centerX: number
  readonly centerY: number
}

/**
 * 把墨迹分成连通块（8 连通），从大到小返回。
 *
 * 开发版标记就靠这个验：正式版是**一整块**，开发版必须是**两块**——标志与右下角那颗
 * 圆点各算一块。少了圆点会退化成一整块，圆点粘在标志上也是一整块，两种都能被这条抓住。
 */
function blots(raster: Raster): Blot[] {
  const seen = new Uint8Array(raster.width * raster.height)
  const found: Blot[] = []
  for (let start = 0; start < seen.length; start += 1) {
    const startX = start % raster.width
    const startY = (start - startX) / raster.width
    if (seen[start] === 1 || !isSolid(raster, startX, startY)) continue
    let size = 0
    let sumX = 0
    let sumY = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const at = stack.pop() ?? 0
      const x = at % raster.width
      const y = (at - x) / raster.width
      size += 1
      sumX += x
      sumY += y
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue
          const neighbour = ny * raster.width + nx
          if (seen[neighbour] === 1 || !isSolid(raster, nx, ny)) continue
          seen[neighbour] = 1
          stack.push(neighbour)
        }
      }
    }
    found.push({ size, centerX: sumX / size, centerY: sumY / size })
  }
  return found.sort((left, right) => right.size - left.size)
}

// ---------------------------------------------------------------- 产物清单

const APP_BUILD = '../../../apps/app/build/'
const BRAND_PNG = '../../../apps/docs/assets/brand/png/'
const DOCS_PUBLIC = '../../../apps/docs/public/'
const WWW_PUBLIC = '../../../apps/www/public/'
const SOURCE_SVG = '../../../packages/console/public/icon.svg'

/** 矢量源的副本：生成脚本每次运行都会重写它们，字节必须与真源一致。 */
const SOURCE_COPIES = ['../../../apps/docs/assets/brand/icon.svg', `${DOCS_PUBLIC}logo.svg`, `${DOCS_PUBLIC}favicon.svg`, `${WWW_PUBLIC}icon.svg`] as const

/** 彩色派生图（透明底）。名字是 `main.ts` / `electron-builder.config.cjs` 按字面引用的。 */
const COLOUR_ICONS = [
  { file: `${APP_BUILD}icon.png`, size: 1024 },
  { file: `${APP_BUILD}icon-mac.png`, size: 1024 },
  { file: `${BRAND_PNG}icon-1024.png`, size: 1024 },
  { file: `${BRAND_PNG}icon-512.png`, size: 512 },
  { file: `${BRAND_PNG}icon-256.png`, size: 256 },
  { file: `${BRAND_PNG}icon-128.png`, size: 128 },
  { file: `${BRAND_PNG}icon-64.png`, size: 64 },
  { file: `${BRAND_PNG}icon-32.png`, size: 32 },
  { file: `${DOCS_PUBLIC}icon-256.png`, size: 256 },
] as const

/** 单色派生图：同一套几何，只把渐变换成一种颜色。 */
const MONO_ICONS = [
  { file: `${BRAND_PNG}icon-mono-white-1024.png`, size: 1024, value: 255 },
  { file: `${BRAND_PNG}icon-mono-black-1024.png`, size: 1024, value: 0 },
] as const

/**
 * 托盘蒙版：纯白 + alpha，1× 与 2× 两档。`dev` 那份是开发版（标志右下角一颗圆点），
 * `main.ts` 的 `trayTemplate()` 按 `app.isPackaged` 挑正式/开发文件。
 *
 * Windows 不在这张表里：它吃的是 `icon-win.ico`（多尺寸，系统按 DPI 自己挑一档），
 * 所以也没有「Windows 版的 48² 大图」这种东西——非 `.ico` 来源的 `GetHICON` 会丢掉
 * 尺寸参数、只取 1× 那一档，那正是 Windows 必须走 ICO 的原因。
 */
const TRAY = [
  { file: `${APP_BUILD}trayTemplate.png`, size: 16, dev: false },
  { file: `${APP_BUILD}trayTemplate@2x.png`, size: 32, dev: false },
  { file: `${APP_BUILD}trayTemplate-dev.png`, size: 16, dev: true },
  { file: `${APP_BUILD}trayTemplate-dev@2x.png`, size: 32, dev: true },
] as const

/** Windows 的 ico 档位，与生成脚本里那张表一致。20 是 125% 缩放那一档，最容易被漏掉。 */
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 256] as const
const ICO_FILE = `${APP_BUILD}icon-win.ico`

/**
 * 真源里的标志：一个圆角矩形，两只眼是**挖空的**（同一个 mask 里的黑圆）。
 * 换标志就得连这个测试一起改，这是故意的。
 */
const MARK = { x: 16, y: 34, width: 224, height: 188, radius: 62, canvas: 256 } as const
const MARK_RECT = `x="${MARK.x}" y="${MARK.y}" width="${MARK.width}" height="${MARK.height}" rx="${MARK.radius}"`
/** 三段渐变（osw 那道闪电的前三段，去掉末端的紫）。 */
const MARK_STOPS = [
  { offset: '0', color: '#FFE066' },
  { offset: '0.42', color: '#FF9500' },
  { offset: '1', color: '#F0297C' },
] as const
const EYES = [
  { cx: 85, cy: 128, r: 24 },
  { cx: 171, cy: 128, r: 24 },
] as const
/** 深色底板：`design-system.md` §2 的深色 `--bg`。 */
const DARK_BACKGROUND = [0x19, 0x1a, 0x1c] as const
/** social preview 上标志占画布高度的比例，与生成脚本里的 `SOCIAL_PREVIEW.markRatio` 一致。 */
const SOCIAL_MARK_RATIO = 0.64

/**
 * 几何对账的容差，单位是**像素**而不是比例。
 *
 * 16px 上一个像素就是 6.25%，按比例给会松到什么都测不出；而反锯齿外扩一格、
 * 降采样取整这两件事合起来不会超过 1.5px。
 */
const GEOMETRY_TOLERANCE = 1.5

/** 几何对账的基准：最精细的那张（1024²）。别的尺寸都缩到它上面比。 */
const REFERENCE = rasterOf(`${APP_BUILD}icon.png`)
const REFERENCE_BOX = shapeBox(REFERENCE, undefined)

/**
 * 全部产物，一处列全。清单对账拿它当「应该有哪几张」的答案。
 *
 * 由上面几张表推出来而不是再抄一遍：抄一遍的意思是「加了一张图、这里忘了补」
 * 会变成一条无声的漏检，而这张表的全部意义就是没有漏检。
 */
const PRODUCTS = [
  ...COLOUR_ICONS.map((entry) => entry.file),
  ...MONO_ICONS.map((entry) => entry.file),
  ...TRAY.map((entry) => entry.file),
  ICO_FILE,
  `${BRAND_PNG}icon-on-dark-1024.png`,
  `${BRAND_PNG}social-preview.png`,
  ...SOURCE_COPIES,
] as const

/** 产物 sha256 清单，由 `pnpm icons` 每次重写。**不是**手编的常量。 */
const HASH_MANIFEST = '../../../packages/console/source/brand-assets.hash.json'
/** 清单里的键是仓库相对路径（生成脚本的 `toPosix`），这里把测试用的相对路径换算过去。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const repoPath = (file: string): string =>
  fileURLToPath(new URL(file, import.meta.url)).slice(REPO_ROOT.length).replaceAll('\\', '/')

describe('矢量源：一个文件，所有派生图都从它来', () => {
  const source = textOf(SOURCE_SVG)

  it('真源里就是那个标志（圆角矩形 + 两只挖空的眼睛 + 三段渐变），不是一张空 svg', () => {
    expect(source).toContain('viewBox="0 0 256 256"')
    expect(source).toContain('aria-label="abx"')
    expect(source).toContain(MARK_RECT)
    // 眼睛必须在同一个 mask 里、而且被这个 rect 用上：分开写的话「挖空」就不成立了。
    expect(source).toContain('mask="url(#abx-eyes)"')
    for (const eye of EYES) expect(source).toContain(`<circle cx="${eye.cx}" cy="${eye.cy}" r="${eye.r}" fill="#000"/>`)
    for (const stop of MARK_STOPS) expect(source).toContain(`offset="${stop.offset}" stop-color="${stop.color}"`)
  })

  it('标志自带留白，且没有描边——留白就是那个矩形本身', () => {
    // 这条守着「各尺寸直接等比缩放、不需要扫墨迹框」这个判断，缘由写在生成脚本的文件头。
    // 有描边的话墨迹框会比矩形大一圈（上一版正是如此），下面那组几何对账的基准就不是
    // 这个矩形了——所以「没有描边」是那个判断的前提，得在这里钉住。
    expect(source).not.toContain('stroke')
    expect(MARK.x * 2 + MARK.width).toBe(MARK.canvas)
    expect(MARK.y * 2 + MARK.height).toBe(MARK.canvas)
  })

  it('站点与文档引用的每一份都是真源的副本，逐字节一致', () => {
    for (const file of SOURCE_COPIES) expect([file, textOf(file) === source]).toEqual([file, true])
  })
})

describe('打包与导出：尺寸精确', () => {
  it('每一档都是它该有的尺寸', () => {
    for (const { file, size } of [...COLOUR_ICONS, ...MONO_ICONS]) {
      const raster = rasterOf(file)
      expect([file, raster.width, raster.height]).toEqual([file, size, size])
    }
  })

  it('彩色那张真的是那条三段渐变，不是单色填充', () => {
    // 两个采样点，落在渐变的两头（左上偏黄、右下偏品红），坐标按真源的 256 空间给。
    // 只查一点是查不出「渐变没了」的：一个纯橙色块能满足任何单点断言。
    const raster = rasterOf(`${APP_BUILD}icon.png`)
    const unit = raster.width / MARK.canvas
    const at = (x: number, y: number): readonly number[] => pixelAt(raster, Math.round(x * unit), Math.round(y * unit))
    const [yellowRed, yellowGreen, yellowBlue, yellowAlpha] = at(50, 70)
    const [pinkRed, pinkGreen, pinkBlue, pinkAlpha] = at(210, 200)
    expect([yellowAlpha, pinkAlpha]).toEqual([255, 255])
    // 两头都是暖色（红最高），但绿的走向必须是从上到下变低、蓝的走向反过来。
    expect([yellowGreen > pinkGreen, yellowBlue < pinkBlue]).toEqual([true, true])
    for (const [red, green, blue] of [
      [yellowRed, yellowGreen, yellowBlue],
      [pinkRed, pinkGreen, pinkBlue],
    ]) {
      expect(red).toBeGreaterThan(green)
      expect(red).toBeGreaterThan(blue)
    }
  })

  it('眼睛是挖空的洞（alpha 洞），不是画上去的白点', () => {
    // 这条守着一个很容易写错的地方：生成脚本做单色档时要把渐变引用换成一种颜色，
    // 而 `mask="url(#abx-eyes)"` 的写法和渐变引用一模一样——一起换掉的话，
    // 眼睛就不再是洞，单色档变成一张没有眼睛的实心色块。查 alpha 才查得出来。
    //
    // 判据用 `SOLID` 而不是「恰好 0」：16px 上那只洞只有 3px 宽，圆心落在一个
    // 没被完全覆盖的像素上时 alpha 是十几而不是 0，那仍然是洞。画上去的白点是 255。
    for (const { file, size } of [
      { file: `${APP_BUILD}icon.png`, size: 1024 },
      { file: `${APP_BUILD}trayTemplate.png`, size: 16 },
      { file: `${APP_BUILD}trayTemplate@2x.png`, size: 32 },
      ...MONO_ICONS.map((entry) => ({ file: entry.file, size: entry.size })),
    ]) {
      const raster = rasterOf(file)
      const unit = size / MARK.canvas
      for (const eye of EYES) {
        const [x, y] = [Math.round(eye.cx * unit), Math.round(eye.cy * unit)]
        expect([file, x, y, pixelAt(raster, x, y)[3] <= SOLID]).toEqual([file, x, y, true])
      }
      // 两只眼必须是**两只**：中间那道鼻梁若也成了洞，就是整个 mask 写反了。
      const [bridgeX, bridgeY] = [Math.round((MARK.canvas / 2) * unit), Math.round(128 * unit)]
      expect([file, pixelAt(raster, bridgeX, bridgeY)[3] > SOLID]).toEqual([file, true])
    }
  })
})

describe('icon-win.ico：真的含 7 档，而不是「文件在了」', () => {
  const bytes = bytesOf(ICO_FILE)

  it('容器头是 ICO，档数就是 7', () => {
    expect([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)]).toEqual([0, 1, ICO_SIZES.length])
  })

  it('每一档的目录项与内嵌 PNG 都读得出来，尺寸逐档对上', () => {
    for (const [index, size] of ICO_SIZES.entries()) {
      const at = 6 + index * 16
      const length = bytes.readUInt32LE(at + 8)
      const offset = bytes.readUInt32LE(at + 12)
      const frame = bytes.subarray(offset, offset + length)
      // 256 在目录项里写 0：一个字节放不下 256。
      const given = size >= 256 ? 0 : size
      expect([index, bytes[at], bytes[at + 1]]).toEqual([index, given, given])
      expect([index, frame.subarray(0, 8).equals(PNG_SIGNATURE)]).toEqual([index, true])
      expect([index, sizeOfPng(frame)]).toEqual([index, { width: size, height: size }])
    }
  })
})

describe('托盘蒙版：纯白 + alpha，开发版多一颗圆点', () => {
  it('每一张的尺寸精确', () => {
    for (const { file, size } of TRAY) {
      const raster = rasterOf(file)
      expect([file, raster.width, raster.height]).toEqual([file, size, size])
    }
  })

  it('所有不透明的像素 RGB 都是纯白', () => {
    // 模板图的形状**只**由 alpha 表达。降采样会把边缘像素的 RGB 与透明像素（0,0,0）
    // 平均成灰，所以生成脚本特意把 RGB 全部压成纯白——这条就是那道工序的回执。
    for (const { file } of TRAY) {
      const raster = rasterOf(file)
      const tinted: string[] = []
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) {
          const [red, green, blue, alpha] = pixelAt(raster, x, y)
          if (alpha > 0 && (red !== 255 || green !== 255 || blue !== 255)) tinted.push(`${x},${y}=${red},${green},${blue},${alpha}`)
        }
      }
      expect([file, tinted.slice(0, 3)]).toEqual([file, []])
    }
  })

  it('正式版是一整块，开发版是两块（标志 + 右下角那颗圆点）', () => {
    for (const { file, size, dev } of TRAY) {
      const found = blots(rasterOf(file))
      expect([file, found.length]).toEqual([file, dev ? 2 : 1])
      if (!dev) continue
      // 圆点得在右下角，而且真的比标志小：「忘了加圆点」与「圆点糊进标志」都过不了这条。
      const [mark, dot] = found
      expect([file, dot.size < mark.size, dot.centerX > size / 2, dot.centerY > size / 2]).toEqual([file, true, true, true])
    }
  })

  it('开发版与正式版不是同一张图', () => {
    for (const { file, dev } of TRAY) {
      if (!dev) continue
      const production = file.replace('-dev', '')
      expect([file, bytesOf(file).equals(bytesOf(production))]).toEqual([file, false])
    }
  })
})

describe('一套几何：所有派生图共用同一个轮廓', () => {
  it('基准就是真源那个矩形，而且左右对称、上下对称', () => {
    // 这条同时是「不需要扫墨迹框」的证据，也是**唯一**把位图钉回矢量源几何的一处。
    // 容差给 2px（1024 上 0.2%）：改一个用户空间单位就是 4px，跑不掉。
    const unit = REFERENCE.width / MARK.canvas
    const insets = {
      left: REFERENCE_BOX.x,
      right: REFERENCE.width - (REFERENCE_BOX.x + REFERENCE_BOX.width),
      top: REFERENCE_BOX.y,
      bottom: REFERENCE.height - (REFERENCE_BOX.y + REFERENCE_BOX.height),
    }
    for (const [edge, inset] of Object.entries(insets)) {
      const expected = (edge === 'left' || edge === 'right' ? MARK.x : MARK.y) * unit
      expect([edge, Math.abs(inset - expected) <= 2]).toEqual([edge, true])
    }
    // 对称比定值更抗漂移：标志可以在画布里整体挪，但不能挪歪——而「挪歪」正是
    // 上一版真的发生过的事（y 从 34 写成 44，上下留白差 24，肉眼看不出来）。
    expect([Math.abs(insets.left - insets.right) <= 2, Math.abs(insets.top - insets.bottom) <= 2]).toEqual([true, true])
  })

  it('每一张的图形都落在同一处、同样大小', () => {
    const entries = [
      ...COLOUR_ICONS.filter((entry) => entry.size !== 1024),
      ...MONO_ICONS,
      ...TRAY.filter((entry) => !entry.dev).map((entry) => ({ file: entry.file, size: entry.size })),
      { file: `${BRAND_PNG}icon-on-dark-1024.png`, size: 1024, background: DARK_BACKGROUND },
    ]
    for (const entry of entries) {
      const raster = rasterOf(entry.file)
      const box = shapeBox(raster, 'background' in entry ? entry.background : undefined)
      const scale = entry.size / REFERENCE.width
      const expected = {
        left: REFERENCE_BOX.x * scale,
        top: REFERENCE_BOX.y * scale,
        right: (REFERENCE_BOX.x + REFERENCE_BOX.width) * scale,
        bottom: (REFERENCE_BOX.y + REFERENCE_BOX.height) * scale,
      }
      const deltas = [
        Math.abs(box.x - expected.left),
        Math.abs(box.y - expected.top),
        Math.abs(box.x + box.width - expected.right),
        Math.abs(box.y + box.height - expected.bottom),
      ]
      // 一条断言带上「哪张、四条边各差多少」，比四个 toBeLessThan 好定位。
      expect([entry.file, deltas.map((delta) => delta <= GEOMETRY_TOLERANCE)]).toEqual([entry.file, [true, true, true, true]])
    }
  })
})

describe('文档导出：单色、底板与社交预览', () => {
  it('单色档的每个不透明像素都是纯白 / 纯黑', () => {
    for (const { file, value } of MONO_ICONS) {
      const raster = rasterOf(file)
      const tinted: string[] = []
      for (let y = 0; y < raster.height; y += 1) {
        for (let x = 0; x < raster.width; x += 1) {
          const [red, green, blue, alpha] = pixelAt(raster, x, y)
          if (alpha === 0) continue
          if (red !== value || green !== value || blue !== value) tinted.push(`${x},${y}=${red},${green},${blue}`)
        }
      }
      expect([file, tinted.slice(0, 3)]).toEqual([file, []])
    }
  })

  it('深色底板那张整幅不透明，底色就是设计体系的深色 --bg', () => {
    const raster = rasterOf(`${BRAND_PNG}icon-on-dark-1024.png`)
    const corner = [...DARK_BACKGROUND, 255]
    expect(pixelAt(raster, 0, 0)).toEqual(corner)
    expect(pixelAt(raster, raster.width - 1, raster.height - 1)).toEqual(corner)
    expect(pixelAt(raster, 0, raster.height - 1)).toEqual(corner)
  })

  it('social preview 是 1280×640，标志居中且没有被拉伸', () => {
    // GitHub 的仓库预览图固定这个尺寸，比例不对会被裁掉两边。
    const raster = rasterOf(`${BRAND_PNG}social-preview.png`)
    expect([raster.width, raster.height]).toEqual([1280, 640])
    const box = shapeBox(raster, DARK_BACKGROUND)
    // 左右与上下都对称 = 居中。
    expect(Math.abs(raster.width - (box.x + box.width) - box.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(raster.height - (box.y + box.height) - box.y)).toBeLessThanOrEqual(2)
    // 标志不是方图（头是 224×188），所以比的是**真源那个矩形的宽高比**：
    // 拉伸或裁切都会让这个比值跑掉，而「居中」那两条不会。
    expect(box.width / box.height).toBeCloseTo(MARK.width / MARK.height, 1)
    // 占画布高度的比例 = markRatio × 标志在 256 里自己的高度占比（那 0.734 是自带留白）。
    expect(box.height / raster.height).toBeCloseTo(SOCIAL_MARK_RATIO * (REFERENCE_BOX.height / REFERENCE.height), 2)
  })

  it('文档站那张 256 就是品牌目录里那张，不是另渲一份', () => {
    expect(bytesOf(`${DOCS_PUBLIC}icon-256.png`).equals(bytesOf(`${BRAND_PNG}icon-256.png`))).toBe(true)
  })
})

describe('sha256 清单：手改一张 png 就跑不过', () => {
  /** 清单是 `pnpm icons` 写的，不是手编的；这里只读它，从不改它。 */
  const manifest = JSON.parse(textOf(HASH_MANIFEST)) as { assets: Record<string, string> }

  it('清单覆盖的正是全部产物，不多不少', () => {
    // 少一条 = 有人加了产物却没人给它记账；多一条 = 清单里留着已经删掉的文件。
    // 两种都是「清单不再描述现实」，而清单的全部价值就是它描述现实。
    expect(Object.keys(manifest.assets).sort()).toEqual(PRODUCTS.map(repoPath).sort())
  })

  it('每一个产物的 sha256 都与清单一致', () => {
    // 上面那些断言看的是「画得对不对」，这一条看的是「这张图是不是生成器产出的那一张」：
    // 几何全对、颜色也对、但内容被人涂改过的 png，只有指纹能抓住。
    // 红了不代表产物错了——先想想有没有人手改过 png；确实改了真源就重跑 `pnpm icons`。
    for (const file of PRODUCTS) {
      const at = repoPath(file)
      const digest = createHash('sha256').update(bytesOf(file)).digest('hex')
      expect([at, digest]).toEqual([at, manifest.assets[at]])
    }
  })
})
