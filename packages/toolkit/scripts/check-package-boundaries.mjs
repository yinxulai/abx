import { readdir, readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/log.mjs'

// 包边界校验。
//
// 目录是不是「包」，只写在文档里没有约束力：跨包 import 能编译、能测试，
// 直到想把某个包单独发布或复用时才发现拆不开。这里把两条边界变成可执行的检查：
//
//   ① `packages/*` 是能力包，`apps/*` 是宿主。能力包不得反向依赖宿主——
//      否则那个包就再也离不开这个应用了。
//   ② 跨包 import（含相对路径绕过包名的那种）必须在自己的 `package.json` 里声明依赖。
//      没声明的依赖能跑起来只是因为 pnpm 的 node_modules 恰好放得下，
//      换一个安装布局就断。
//
// 静态 import 检查，新增文件自动纳入，不维护白名单。
// 包清单从 `pnpm-workspace.yaml` 现算，加包不需要改这里。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** `pnpm-workspace.yaml` 里 `packages:` 那一节的条目。 */
function workspacePatterns() {
  const lines = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n')
  const start = lines.findIndex(line => /^packages:\s*$/.test(line))
  if (start === -1) throw new Error('pnpm-workspace.yaml 里找不到 `packages:`')

  const patterns = []
  for (const line of lines.slice(start + 1)) {
    // 顶格的下一节（例如 `allowBuilds:`）表示列表结束。
    if (/^\S/.test(line)) break
    const entry = line.match(/^\s*-\s*(\S+)\s*$/)?.[1]
    if (entry !== undefined) patterns.push(entry)
  }
  return patterns
}

/** 展开 `dir/*` 这类模式，返回「相对仓库根的包目录」，posix 分隔符，已排序。 */
function workspaceDirectories() {
  return workspacePatterns()
    .flatMap(pattern => {
      if (!pattern.endsWith('/*')) return [pattern]
      const parent = pattern.slice(0, -2)
      // `apps/` 这类目录在骨架期可能整个不存在，而 git 不跟踪空目录——
      // 少一个目录是「还没有成员」，不是错误。
      if (!fs.existsSync(path.join(root, parent))) return []
      return fs.readdirSync(path.join(root, parent), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => `${parent}/${entry.name}`)
    })
    .filter(directory => fs.existsSync(path.join(root, directory, 'package.json')))
    .sort()
}

/** 读取每个包的 manifest，返回「包名 → { directory, kind, declared }」。 */
function readPackages() {
  const packages = new Map()
  for (const directory of workspaceDirectories()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string') continue
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
    packages.set(manifest.name, {
      directory,
      kind: directory.startsWith('apps/') ? 'app' : 'package',
      declared,
    })
  }
  return packages
}

/** 所有 `from '...'` / `import('...')` / `require('...')` 的模块说明符。 */
const IMPORT_PATTERN = /(?:from|import\(|require\()\s*'([^']+)'/g

async function collectSourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(relative)))
      continue
    }
    // 测试文件为了搭夹具可以 import 任意模块，边界约束只作用于源码。
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(relative)
    }
  }
  return files
}

/** 判断一个仓库内绝对路径属于哪个包，不在任何包目录内时返回 null。 */
function resolveOwner(absolutePath, packages) {
  const normalized = absolutePath.replaceAll(path.sep, '/')
  for (const [name, item] of packages) {
    const packageRoot = path.join(root, item.directory).replaceAll(path.sep, '/')
    if (normalized === packageRoot || normalized.startsWith(`${packageRoot}/`)) return name
  }
  return null
}

/**
 * 把说明符归一成目标包名。
 *
 * 相对导入必须解析后再判断，否则一个 `../../other-package/source/x` 就能绕开全部规则；
 * 解析不出归属的（如包外资源 `../assets/icon.png`）返回 null，不猜。
 */
function resolveTarget(specifier, file, packages) {
  if (specifier.startsWith('.')) {
    return resolveOwner(path.resolve(root, path.dirname(file), specifier), packages)
  }
  for (const name of packages.keys()) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return name
  }
  return null
}

async function main() {
  log.title('Package boundary check')

  const packages = readPackages()
  const violations = []
  let checked = 0

  for (const [packageName, item] of packages) {
    const files = await collectSourceFiles(item.directory)
    for (const file of files) {
      checked += 1
      const source = await readFile(path.join(root, file), 'utf8')
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1]
        const target = resolveTarget(specifier, file, packages)
        if (target === null || target === packageName) continue

        const targetItem = packages.get(target)
        if (item.kind === 'package' && targetItem.kind === 'app') {
          violations.push(`${file} → ${specifier}（能力包不得依赖宿主应用 ${target}）`)
          continue
        }
        if (!item.declared.has(target)) {
          violations.push(`${file} → ${specifier}（${packageName} 未在 package.json 中声明依赖 ${target}）`)
        }
      }
    }
  }

  if (violations.length > 0) {
    log.error(`Package boundary check failed（${violations.length} 处越界）`)
    for (const violation of violations) {
      console.log(`  ${violation}`)
    }
    process.exit(1)
  }

  log.success(`Package boundaries respected（${packages.size} packages, ${checked} files）`)
}

main()
