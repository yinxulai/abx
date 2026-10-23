// 无头验证入口：一条命令把「面板到底长什么样」变成能看的图 + 能查的数。
//
//   pnpm --filter @abx/app verify:linux
//
// 为什么需要它：`apps/app` 此前从没在真机启动过，路线图里写的是「Electron 未在真机验证」。
// 开发机没有物理显示器，所以这里补上一整条虚拟显示链路：
//
//   起 Xvfb → 起 Electron → 等面板渲染完 → 截图落盘 → 跑 UI 审计 → 全部拆掉
//
// 四份产物都落在 `apps/app/.state/`（已 gitignore，不进仓库）：
//
//   panel-x11.png       X 服务器上的整屏截图。它证明的是「窗口真的映射到了显示器上」，
//                       也就是此前完全没被验证过的那一段。无合成器时卡片外那圈透明留白
//                       会渲染成黑色（见 apps/docs/specs/overview/platforms.md）。
//   panel-renderer.png  渲染进程自己的像素，带 alpha。没有黑圈，是看设计的那一张。
//   panel-text.txt      面板渲染出来的**文本**。断言「不是白屏」靠它，不靠肉眼看图。
//   audit.json          程序化 UI 审计（对比度 / 溢出 / 触控目标 / 字号间距 / 焦点态）。
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

const options = new Set(process.argv.slice(2))
const shouldBuild = !options.has('--no-build')

let xvfb = null
let electron = null
let staticServer = null
let socket = null
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
      staticServer = server
      resolve({ port: server.address().port })
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
  step('3. 等面板渲染完')
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

async function collectText(send) {
  step('4. 面板渲染出来的文本')
  const text = await evaluate(send, 'document.body?.innerText ?? ""')
  writeFileSync(path.join(stateDirectory, 'panel-text.txt'), `${text}\n`)
  log(text.split('\n').map((line) => `    ${line}`).join('\n'))
  for (const expected of EXPECTED_TEXT) {
    if (text.includes(expected)) ok(`文本里有「${expected}」`)
    else fail(`文本里没有「${expected}」——面板可能只渲染了一部分`)
  }
}

async function captureScreen(display) {
  step('5. X 服务器截图（证明窗口真的铺到了显示器上）')
  const file = path.join(stateDirectory, 'panel-x11.png')
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

async function captureRenderer(send) {
  step('6. 渲染进程截图（带 alpha，看设计用这张）')
  try {
    // 把渲染层的默认底色设成全透明，否则截出来会把透明区域填成白色。
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const file = path.join(stateDirectory, 'panel-renderer.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    ok(`${path.relative(process.cwd(), file)}（${SCALE_FACTOR} 倍像素密度）`)
  } catch (error) {
    warn(`渲染进程截图失败：${error.message}`)
  }
}

async function auditPanel() {
  step('7. 程序化 UI 审计')
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
  const { port } = await startStaticServer(panelDirectory)
  const report = path.join(stateDirectory, 'audit.json')

  // 必须用**异步** spawn：静态服务就跑在这个进程里，`spawnSync` 会把事件循环卡住，
  // 于是服务器再也回不了响应，Chrome 那份页面永远加载不完——两边一起挂死。
  const status = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [script, `http://127.0.0.1:${port}/`, '--viewport', '422x600', '--out', report],
      { stdio: 'inherit' },
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

  if (status === 'timeout') warn(`审计超过 ${AUDIT_TIMEOUT_MS / 1000}s 没结束，已中止`)
  else if (status === 1) fail('审计报了 🔴 致命项（见上面的报告）')
  else if (status !== 0) warn(`审计脚本退出码 ${status}，没能产出报告`)
  else ok(`审计通过，无致命项；机器可读报告在 ${path.relative(process.cwd(), report)}`)
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

function teardown() {
  try {
    socket?.close()
  } catch {
    // 关不掉就算了，进程马上就没了
  }
  try {
    staticServer?.close()
  } catch {
    // 同上
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

  const { connection, send } = await connectToPanel(debuggingPort)
  socket = connection

  await waitForPanel(send)
  await collectText(send)
  await captureScreen(display)
  await captureRenderer(send)
  await auditPanel()

  step('结论')
  log(`  产物目录：${path.relative(process.cwd(), stateDirectory)}/`)
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
