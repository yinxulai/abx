import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 构建的最后一步：把 SSR 渲染出来的正文注入客户端产物 `output/index.html`。
 *
 * 顺序是刻意的：`vite build` 先产出客户端产物（CSS/JS 的哈希文件名都在里面），
 * 再跑 SSR 构建，最后才用这份 HTML 做模板。反过来的话客户端构建的
 * `emptyOutDir` 会把注入结果一起清掉。
 *
 * 注入点只有一个、且必须是唯一的 `<div id="root"></div>`：
 * 找不到（例如以后有人在模板里给 #root 加了别的内容）就直接失败，
 * 而不是悄悄产出一份没有正文的页面。
 */
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDirectory = path.join(appDirectory, 'output-ssr')
const indexPath = path.join(appDirectory, 'output', 'index.html')
const ROOT_MARKER = '<div id="root"></div>'

const serverEntries = (await readdir(serverDirectory)).filter(name => name.endsWith('.js'))
if (serverEntries.length !== 1) {
  throw new Error(
    `expected exactly one SSR entry in ${serverDirectory}, found ${serverEntries.length}`,
  )
}

const serverEntry = path.join(serverDirectory, serverEntries[0])
const { renderLandingPage } = await import(pathToFileURL(serverEntry).href)
const markup = await renderLandingPage()

if (markup.trim().length === 0) {
  throw new Error('the server render produced no markup')
}

const template = await readFile(indexPath, 'utf8')
const markerCount = template.split(ROOT_MARKER).length - 1
if (markerCount !== 1) {
  throw new Error(`expected exactly one "${ROOT_MARKER}" in ${indexPath}, found ${markerCount}`)
}

await writeFile(indexPath, template.replace(ROOT_MARKER, `<div id="root">${markup}</div>`))
// SSR 产物只在这一步有用；留着它会让下一次构建多一份没人读的垃圾。
await rm(serverDirectory, { recursive: true, force: true })

console.log(
  `prerendered ${Buffer.byteLength(markup)} bytes of markup into ${path.relative(appDirectory, indexPath)}`,
)
