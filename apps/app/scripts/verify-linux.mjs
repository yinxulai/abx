// 无头验证入口：一条命令把「面板到底长什么样」变成能看的图 + 能查的数。
//
//   pnpm --filter @abx/app verify:linux
//
// 为什么需要它：`apps/app` 此前从没在真机启动过，路线图里写的是「Electron 未在真机验证」。
// 开发机没有物理显示器，所以这里补上一整条虚拟显示链路：
//
//   起 Xvfb → 起 Electron → 等面板渲染完 → 截图落盘 → 跑 UI 审计 → 全部拆掉
//
// **明暗两套都跑。** 面板的颜色跟着 `@media (prefers-color-scheme: dark)` 走，
// 只量一套等于只验证了一半：浅色卡上与深色卡上「同一档灰」的对比度能差出一倍。
// 两轮各自强制一次配色（渲染进程一侧用 CDP 的 `Emulation.setEmulatedMedia`，
// 审计脚本自己拉的那个 Chrome 用 Blink 的 `preferredColorScheme`，见 auditPanel()）。
//
// 产物都落在 `apps/app/.state/`（已 gitignore，不进仓库），深色那一轮带 `-dark` 后缀：
//
//   panel-x11.png            X 服务器上的整屏截图。它证明的是「窗口真的映射到了显示器上」，
//                            也就是此前完全没被验证过的那一段。无合成器时卡片外那圈透明
//                            留白会渲染成黑色（见 apps/docs/specs/overview/platforms.md）。
//   panel-renderer.png       渲染进程自己的像素，带 alpha。没有黑圈，是看设计的那一张。
//   panel-text.txt           面板渲染出来的**文本**。断言「不是白屏」靠它，不靠肉眼看图。
//   audit.json               程序化 UI 审计（对比度 / 溢出 / 触控目标 / 字号间距 / 焦点态）。
//   panel-x11-dark.png       …以上四份在深色配色下的对应物。
//   panel-renderer-dark.png
//   panel-text-dark.txt
//   audit-dark.json
//
// 审计脚本来自本机的 design-review-loop 技能，用 `ABX_AUDIT_SCRIPT` 覆盖它的路径；
// 找不到时只警告，不影响截图这条主线。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFile, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronBinary from 'electron'
import { sandboxArguments } from './electron-sandbox.mjs'

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(appDirectory, '.state')
const panelDirectory = path.join(appDirectory, 'output/panel')
const panelEntry = path.join(panelDirectory, 'index.html')

/** 面板在 Xvfb 里以 2 倍像素密度渲染：一张 366px 宽的卡片只有 366 个像素，
 *  人和审阅工具都看不清；2 倍之后是 732px，文字才有可读的笔画。 */
const SCALE_FACTOR = 2
/** 面板必须出现这几段文本，否则就是渲染失败或只出来一个空壳。 */
const EXPECTED_TEXT = ['abx', '共享给全部 agent', 'Claude Code']
/** 窗口高度由内容决定，等它连续两轮不变就认为布局收敛了。 */
const STABLE_POLLS = 2
/** 审计脚本自己要拉一个 headless Chrome，正常十几秒；超过这个上限就没必要再等。 */
const AUDIT_TIMEOUT_MS = 120_000
/** 两种配色各跑一轮；`--scheme light` 可以只跑其中一轮。 */
const SCHEMES = ['light', 'dark']
const SCHEME_SUFFIX = { light: '', dark: '-dark' }
/** 审计脚本默认拉这个 Chrome（它自己的默认值，这里只是拿来做包装脚本的底）。 */
const DEFAULT_CHROME = '/usr/bin/google-chrome'

const argv = process.argv.slice(2)
const options = new Set(argv)
const shouldBuild = !options.has('--no-build')
const schemeOption = argv[argv.indexOf('--scheme') + 1]
const schemes = options.has('--scheme') ? [schemeOption] : SCHEMES
for (const scheme of schemes) {
  if (scheme !== 'light' && scheme !== 'dark') {
    throw new Error(`--scheme 只认 light / dark，收到 ${String(scheme)}`)
  }
}

let xvfb = null
let electron = null
let socket = null
/** 每轮审计各自要的进程环境（深色那轮带一个壳脚本，见 prepareAuditChrome()）。 */
let auditChrome = { light: {}, dark: {} }
let failures = 0

const log = (message) => process.stdout.write(`${message}\n`)
const step = (title) => log(`\n\x1b[1m=== ${title} ===\x1b[0m`)
const ok = (message) => log(`  \x1b[32m✓\x1b[0m ${message}`)
const warn = (message) => log(`  \x1b[33m!\x1b[0m ${message}`)
const fail = (message) => {
  failures += 1
  log(`  \x1b[31m✗\x1b[0m ${message}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 让内核分配一个空闲端口。写死端口会和别的会话（或上一轮没死透的进程）撞车。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 挑一个没人用的 X display。**不要**去 pkill 别人的 Xvfb：那会连自己的 shell 一起杀。 */
function pickDisplay() {
  for (let number = 99; number < 130; number += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${number}`)) return `:${number}`
  }
  throw new Error('没有空闲的 X display 可用（:99 到 :129 都被占了）')
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
}

/** 极简静态服务：审计脚本要一个 http:// 地址，原因见下面 auditPanel() 的注释。 */
function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = decodeURIComponent(String(request.url).split('?')[0])
      // `/` 必须映射到 index.html：不映射的话读到的是一个目录，整个面板 404，
      // 审计脚本只会报一句「页内审计抛错」，看不出真实原因。
      const relative = url === '/' ? 'index.html' : url.replace(/^\/+/, '')
      const file = path.join(root, relative)
      readFile(file, (error, data) => {
        if (error !== null) {
          response.writeHead(404)
          response.end('not found')
          return
        }
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        })
        response.end(data)
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() })
    })
  })
}

// ── CDP ───────────────────────────────────────────────────────────────────
// 只用到三件事：等到面板那个 target 出现、读它的 DOM、截它的像素。
// 和 design-review-loop 的 audit.mjs 同一套做法（Node 24 自带 WebSocket，零依赖）。

async function connectToPanel(port) {
  let target = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      target = list.find((item) => item.type === 'page' && String(item.url).includes('panel/'))
      if (target?.webSocketDebuggerUrl) break
    } catch {
      // 端口还没起来，继续等
    }
    await sleep(250)
  }
  if (target === null || target === undefined) throw new Error('等不到面板的 devtools target')

  const connection = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    connection.addEventListener('open', resolve)
    connection.addEventListener('error', reject)
  })

  let nextId = 1
  const pending = new Map()
  connection.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiting = pending.get(message.id)
    if (waiting === undefined) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      pending.set(id, { resolve, reject })
      connection.send(JSON.stringify({ id, method, params }))
    })

  return { connection, send }
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })
  if (exceptionDetails) {
    // `text` 只有一句 "Uncaught"，真正的原因在 exception.description 里。
    const reason = exceptionDetails.exception?.description ?? exceptionDetails.text
    throw new Error(reason ?? '页内求值失败')
  }
  return result.value
}

/** 轮询时的求值：页内抛错只当作「还没就绪」，返回 null 让调用方再等一轮。 */
async function evaluateOrNull(send, expression) {
  try {
    return JSON.parse(await evaluate(send, expression))
  } catch {
    return null
  }
}

// ── 各步骤 ────────────────────────────────────────────────────────────────

function buildPanel() {
  step('0. 构建产物')
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: appDirectory,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`构建失败（退出码 ${result.status}）`)
  ok('面板 / 主进程 / preload 三份产物都在')
}

function startXvfb(display) {
  step(`1. 虚拟显示器 Xvfb ${display}`)
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  xvfb.stderr.on('data', (chunk) => process.stderr.write(`[Xvfb] ${chunk}`))
  return sleep(2500)
}

function startApp(display, debuggingPort) {
  step('2. 起 app（面板开局直接摊开）')
  const extra = sandboxArguments(electronBinary)
  if (extra.length > 0) warn(`chrome-sandbox 不可用，追加 ${extra.join(' ')}`)

  electron = spawn(
    electronBinary,
    [
      ...extra,
      `--force-device-scale-factor=${SCALE_FACTOR}`,
      `--remote-debugging-port=${debuggingPort}`,
      '.',
    ],
    {
      cwd: appDirectory,
      env: {
        ...process.env,
        DISPLAY: display,
        // 没有托盘宿主，点不到图标，只能让主进程自己把面板摊开。
        ABX_PANEL_SHOW_ON_START: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  electron.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  electron.stderr.on('data', (chunk) => {
    const text = String(chunk)
    // zygote / 网络服务在退出阶段的噪声，和面板无关。
    if (/zygote|Network service|CreateCommandBuffer/.test(text)) return
    process.stderr.write(`[app] ${text}`)
  })
}

async function waitForPanel(send) {
  let lastHeight = -1
  let stable = 0
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // 页面还在导航时，执行上下文可能刚好被换掉，这一轮求值会失败。
    // 那是等待的一部分，不是结论，所以吞掉继续轮询。
    const state = await evaluateOrNull(
      send,
      // 全部走可选链：轮询有可能在文档还没解析出 body 时先跑一轮，
      // 那一刻 `document.body.innerText` 是抛异常而不是返回 undefined。
      `JSON.stringify({
         children: document.getElementById('root')?.children.length ?? 0,
         text: document.body?.innerText ?? '',
         height: Math.round(document.querySelector('.abx-card')?.getBoundingClientRect().height ?? 0),
       })`,
    )
    if (state !== null && state.children > 0 && state.height > 0) {
      stable = state.height === lastHeight ? stable + 1 : 0
      lastHeight = state.height
      if (stable >= STABLE_POLLS) break
    }
    await sleep(250)
  }
  if (lastHeight <= 0) throw new Error('面板始终没有渲染出内容（#root 一直是空的）')
  ok(`面板渲染完成，卡片高 ${lastHeight}px（CSS 像素）`)
  return lastHeight
}

async function collectText(send, suffix) {
  const text = await evaluate(send, 'document.body?.innerText ?? ""')
  writeFileSync(path.join(stateDirectory, `panel-text${suffix}.txt`), `${text}\n`)
  log(text.split('\n').map((line) => `    ${line}`).join('\n'))
  for (const expected of EXPECTED_TEXT) {
    if (text.includes(expected)) ok(`文本里有「${expected}」`)
    else fail(`文本里没有「${expected}」——面板可能只渲染了一部分`)
  }
}

async function captureScreen(display, suffix) {
  const file = path.join(stateDirectory, `panel-x11${suffix}.png`)
  // 走脚本录里那套免安装工具：scrot 找不到就退到 ffmpeg 的 x11grab。
  const scrot = spawnSync('scrot', ['-o', file], { env: { ...process.env, DISPLAY: display } })
  const captured =
    scrot.status === 0 && existsSync(file)
      ? file
      : (() => {
          spawnSync(
            'ffmpeg',
            ['-y', '-f', 'x11grab', '-i', display, '-frames:v', '1', file],
            { stdio: 'ignore' },
          )
          return file
        })()
  if (!existsSync(captured)) {
    fail('截不到图：scrot 与 ffmpeg 都没成功')
    return
  }
  ok(`${path.relative(process.cwd(), captured)}（整屏 1440x900，含托盘应用外的那圈透明留白）`)
}

async function captureRenderer(send, suffix) {
  try {
    // 把渲染层的默认底色设成全透明，否则截出来会把透明区域填成白色。
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const file = path.join(stateDirectory, `panel-renderer${suffix}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    ok(`${path.relative(process.cwd(), file)}（${SCALE_FACTOR} 倍像素密度）`)
    // 撤掉这次覆盖：它改的是页面默认底色，留着会污染下一轮（浅色那轮的卡片外留白
    // 会变成黑的，深色那轮即使切回浅色也看不出来）。
    await send('Emulation.setDefaultBackgroundColorOverride')
  } catch (error) {
    warn(`渲染进程截图失败：${error.message}`)
  }
}

async function auditPanel(scheme, suffix) {
  const script =
    process.env.ABX_AUDIT_SCRIPT ??
    path.join(
      process.env.HOME ?? '',
      '.openclaw/workspace/skills/design-review-loop/scripts/audit.mjs',
    )
  if (!existsSync(script)) {
    warn(`找不到审计脚本：${script}（用 ABX_AUDIT_SCRIPT 指定，或跳过这一节）`)
    return
  }

  // 审计脚本自己拉一个 headless Chrome，而**普通 Chrome 在 `file://` 下会按 CORS
  // 拒掉模块脚本与样式表**（Electron 不会，所以 app 里好好的）。于是这里起一个静态
  // 服务，把同一份产物用 http:// 递给它——审的是同一份 DOM 与 CSS。
  const { port, close } = await startStaticServer(panelDirectory)
  const report = path.join(stateDirectory, `audit${suffix}.json`)

  // 必须用**异步** spawn：静态服务就跑在这个进程里，`spawnSync` 会把事件循环卡住，
  // 于是服务器再也回不了响应，Chrome 那份页面永远加载不完——两边一起挂死。
  const status = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [script, `http://127.0.0.1:${port}/`, '--viewport', '422x600', '--out', report],
      { stdio: 'inherit', env: { ...process.env, ...auditChrome[scheme] } },
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('timeout')
    }, AUDIT_TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  // 一轮一个端口：不关掉的话深色那轮会多留一个没人读的服务器在监听。
  close()

  if (status === 'timeout') warn(`审计超过 ${AUDIT_TIMEOUT_MS / 1000}s 没结束，已中止`)
  else if (status === 1) fail(`审计报了 🔴 致命项（${scheme}，见上面的报告）`)
  else if (status !== 0) warn(`审计脚本退出码 ${status}，没能产出报告`)
  else ok(`审计通过，无致命项；机器可读报告在 ${path.relative(process.cwd(), report)}`)
}

/**
 * 审计脚本自己拉 Chrome（只认 `CHROME_BIN`），命令行里没有强制配色的开关，
 * 所以深色那一轮给它套一层一次性壳脚本：Blink 的 `preferredColorScheme` 置 0
 * （**0 是深色、1 是浅色**，别凭直觉写反，下面 verifyAuditChrome() 会当场验一遍）。
 * 效果等价于我给渲染进程用的 `Emulation.setEmulatedMedia`，只是审计脚本没给我们
 * 插话的机会——它把 Chrome 拉起来就自己连上去了。
 */
function prepareAuditChrome() {
  const wrapper = path.join(stateDirectory, 'chrome-forced-dark.sh')
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.env.CHROME_BIN ?? DEFAULT_CHROME}" --blink-settings=preferredColorScheme=0 "$@"\n`,
    { mode: 0o755 },
  )
  auditChrome = { light: {}, dark: { CHROME_BIN: wrapper } }
}

/** 只回答一个问题：这个 Chrome 眼里的 `prefers-color-scheme` 是不是深色。 */
const SCHEME_PROBE_URL =
  'data:text/html,<body><script>document.body.textContent=String(matchMedia("(prefers-color-scheme: dark)").matches)</script></body>'

function chromeSaysDark(environment) {
  const result = spawnSync(
    environment.CHROME_BIN ?? DEFAULT_CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--dump-dom',
      SCHEME_PROBE_URL,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status !== 0) return null
  if (result.stdout.includes('>true<')) return true
  if (result.stdout.includes('>false<')) return false
  return null
}

/**
 * 对照组：同一个 Chrome，不套壳是浅色、套上壳是深色。
 *
 * 这一步不能省。深色那一轮**全绿的样子和「壳没生效、其实量的是浅色」一模一样**——
 * 少了这个对照，`audit-dark.json` 里那些 0 到底是真通过还是没量到，没人分得清。
 */
function verifyAuditChrome() {
  step('2b. 审计用的那个 Chrome 认不认强制深色')
  const plain = chromeSaysDark(auditChrome.light)
  const forced = chromeSaysDark(auditChrome.dark)
  if (plain === false && forced === true) {
    ok('不加壳 = 浅色、加壳 = 深色（同一个二进制），深色那一轮量的确实是深色')
    return
  }
  fail(`强制深色没生效（不加壳 ${plain}、加壳 ${forced}），audit-dark.json 不可信`)
}

// ── 一轮配色 ──────────────────────────────────────────────────────────────

/**
 * 把渲染进程强制到某一种配色，并**当场验证真的切过去了**。
 *
 * 不验证的话，深色那一轮可能量到的还是浅色面板——`Emulation` 调用成功返回
 * 不代表 `prefers-color-scheme` 就变了，报告会安静地给出「深色也没问题」的假结论。
 * 判据用卡片自己的计算底色（`--card` 浅色 100%、深色 12%），只看明暗不看具体色值，
 * 免得被四舍五入卡住。
 */
async function applyScheme(send, scheme) {
  await send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  })
  const background = await evaluate(
    send,
    'getComputedStyle(document.querySelector(".abx-card")).backgroundColor',
  )
  const channel = Number.parseInt(background.match(/\d+/)?.[0] ?? '', 10)
  if (Number.isNaN(channel)) {
    fail(`读不出卡片底色（拿到 ${background}），无法确认配色是否切过去了`)
    return
  }
  if ((channel < 128) === (scheme === 'dark')) {
    ok(`prefers-color-scheme: ${scheme} 已生效（卡片底色 ${background}）`)
  } else {
    fail(`强制 ${scheme} 没生效：卡片底色是 ${background}`)
  }
}

/**
 * 面板在**真实渲染进程**里的对比度实测，页内算完把数带回来。
 *
 * `audit.mjs` 也在量同一份 DOM，但它在另一个 Chrome 里、而且**全绿时报告里一个数
 * 都不留**——要报「明暗两套数值」就得自己算。两边结果对得上，也算交叉验证。
 *
 * 算法就是 WCAG 那一套：前景色先按 alpha 混到自己实际压着的底色上，再算相对亮度比。
 * 底色靠往上走父链逐层合成，因为面板里没有一处是纯色直铺的（卡片底、方块底、
 * 状态胶囊底都是 `foreground` 的透明度叠出来的）。
 */
const CONTRAST_PROBE = `(() => {
  const parse = (value) => {
    const parts = String(value).match(/[\\d.]+/g);
    if (parts === null) return null;
    return {
      rgb: parts.slice(0, 3).map(Number),
      alpha: parts.length > 3 ? Number(parts[3]) : 1,
    };
  };
  const over = (top, bottom) => ({
    rgb: top.rgb.map((channel, index) => channel * top.alpha + bottom.rgb[index] * (1 - top.alpha)),
    alpha: 1,
  });
  const luminance = ({ rgb }) => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const show = (value) => 'rgb(' + value.rgb.map((c) => Math.round(c)).join(', ') + ')';
  const contrast = (a, b) => {
    const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (sorted[0] + 0.05) / (sorted[1] + 0.05);
  };
  /** 一路往上合成，直到某一层真的不透明为止；合成不到实底就返回 null（量不了，不猜）。 */
  const backgroundBehind = (element) => {
    let layer = null;
    for (let node = element; node !== null; node = node.parentElement) {
      const own = parse(getComputedStyle(node).backgroundColor);
      if (own === null || own.alpha === 0) continue;
      layer = layer === null ? own : over(layer, own);
      if (layer.alpha >= 1) return layer;
    }
    return null;
  };

  const results = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.querySelector('.abx-card'), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    const element = node.parentElement;
    if (text === '' || element === null || seen.has(element)) continue;
    seen.add(element);
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
    const behind = backgroundBehind(element);
    if (behind === null) continue;
    const foreground = over(parse(style.color), behind);
    results.push({
      el: String(element.className),
      text,
      size: style.fontSize,
      weight: style.fontWeight,
      fg: show(foreground),
      bg: show(behind),
      ratio: Math.round(contrast(foreground, behind) * 100) / 100,
    });
  }
  return results;
})()`

/** WCAG AA 正文下限。面板里的字最小的也有 11px，没有一处够得上「大字」的豁免。 */
const AA_BODY = 4.5

async function measureContrast(send, suffix) {
  const results = await evaluate(send, CONTRAST_PROBE)
  writeFileSync(
    path.join(stateDirectory, `contrast${suffix}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  )
  for (const item of [...results].sort((a, b) => a.ratio - b.ratio)) {
    const line = `${item.ratio.toFixed(2)}:1  ${item.el} "${item.text}" ${item.size}/${item.weight} ${item.fg} on ${item.bg}`
    if (item.ratio < AA_BODY) fail(line)
    else ok(line)
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

function teardown() {
  try {
    socket?.close()
  } catch {
    // 关不掉就算了，进程马上就没了
  }
  for (const child of [electron, xvfb]) {
    if (child !== null && child.exitCode === null) child.kill('SIGTERM')
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(stateDirectory, { recursive: true })
  if (shouldBuild) buildPanel()
  else if (!existsSync(panelEntry)) throw new Error('没有产物可跑；去掉 --no-build 先构建一次')

  const display = pickDisplay()
  const debuggingPort = await freePort()
  await startXvfb(display)
  startApp(display, debuggingPort)

  prepareAuditChrome()
  verifyAuditChrome()

  const { connection, send } = await connectToPanel(debuggingPort)
  socket = connection

  for (const scheme of schemes) {
    const suffix = SCHEME_SUFFIX[scheme]
    step(`3. 面板（${scheme}）`)
    // 先等它渲染出来：`applyScheme` 要读卡片自己的计算样式，卡片还不存在时无从判据。
    await waitForPanel(send)
    await applyScheme(send, scheme)
    // 换配色可能改变行盒高度（字体回退、圆角阴影都不变，但不去假设），再等一次收敛。
    await waitForPanel(send)

    step(`3b. 对比度实测（${scheme}）`)
    await measureContrast(send, suffix)

    step(`4. 面板渲染出来的文本（${scheme}）`)
    await collectText(send, suffix)

    step(`5. X 服务器截图（${scheme}）`)
    await captureScreen(display, suffix)

    step(`6. 渲染进程截图（${scheme}）`)
    await captureRenderer(send, suffix)

    step(`7. 程序化 UI 审计（${scheme}）`)
    await auditPanel(scheme, suffix)
  }

  step('结论')
  log(`  产物目录：${path.relative(process.cwd(), stateDirectory)}/`)
  log(`  配色：${schemes.join(' / ')}（深色那份文件名带 -dark 后缀）`)
  if (failures > 0) {
    log(`\n\x1b[31m${failures} 项没通过。\x1b[0m`)
    return 1
  }
  log('\n\x1b[32m面板在 Xvfb 里正常渲染，截图与审计报告都已落盘。\x1b[0m')
  return 0
}

main()
  .then((code) => {
    teardown()
    process.exitCode = code
  })
  .catch((error) => {
    log(`\n\x1b[31m验证失败：${error.message}\x1b[0m`)
    teardown()
    process.exitCode = 1
  })
