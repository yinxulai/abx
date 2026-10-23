import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/log.mjs'
import { loadAgentRegistry } from './lib/agent-registry.mjs'

// agent 清单的守卫：让「加一个 agent = 加一条数据」这句话有判据。
//
// 四件事，缺一件那句承诺就还是注释：
//
//   ① 注册表自洽 —— 每个 agent 都带镜像（仓库非空、版本钉住、不是 latest）、
//      持久化目录、配置模板。判据只有一份：`agentManifestProblems()`，
//      单测跑的是同一个函数。
//   ② 工具链脚本里不许再写 agent 镜像名 —— 镜像名/版本只能来自注册表，
//      构建脚本与 e2e 都必须经由 `lib/agent-registry.mjs` 读。
//   ③ 不许有第二张 agent 表 —— `packages/*/source` 里除注册表外，
//      没有哪个文件同时列出两个以上 agent id。有第二张表，
//      「加一条数据」就又要改代码。
//   ④ 镜像定义与注册表对得上 —— `images/agents/<id>/Dockerfile` 在的时候，
//      这条 agent 的 `image.version` 不许还是 `AGENT_IMAGE_UNBUILT`。
//
// 后三条都是静态扫描，新文件自动纳入，不维护白名单。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_FILE = 'packages/contracts/source/agents.ts'
const IMAGES_DIR = 'images/agents'

const { AGENT_DEFINITIONS, AGENT_IMAGE_UNBUILT, agentIds, agentManifestProblems } = await loadAgentRegistry()

/** 递归列出目录下的文件（相对仓库根，posix 分隔符）。 */
function collectFiles(directory) {
  const absolute = path.join(root, directory)
  const files = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'output') continue
      files.push(...collectFiles(relative))
      continue
    }
    files.push(relative)
  }
  return files.sort()
}

/**
 * 去掉注释，只留代码。
 *
 * 第二张表的判定必须只看代码：`instance.ts` 的文档注释里顺手写了
 * 「`claude` / `codex` / `dsh`」当例子，那是解释，不是一张表。
 * 先剥注释，再找「用引号括起来的 agent id」，误报就没了。
 *
 * 只处理 TS 的注释形态；`//` 前面允许出现 `:`（`https://` 那种 URL 不算注释）。
 */
function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 这个文件里出现了哪几个 agent id（必须是被引号括起来的完整 id）。 */
function agentIdsInCode(source, ids) {
  const code = stripComments(source)
  return ids.filter((id) => new RegExp(`(['"\`])${escapeRegExp(id)}\\1`).test(code))
}

function checkManifest() {
  const problems = agentManifestProblems(AGENT_DEFINITIONS)
  if (problems.length === 0) {
    log.success(`清单自洽：${agentIds().length} 个 agent（${agentIds().join(' / ')}）`)
    return true
  }

  log.error(`清单自洽性检查没过（${problems.length} 处）`)
  for (const problem of problems) console.log(`  ${problem}`)
  return false
}

function checkNoImageLiterals() {
  const repositories = AGENT_DEFINITIONS.map((agent) => agent.image.repository)
  const files = collectFiles('packages/toolkit/scripts')
  const violations = []

  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8')
    for (const repository of repositories) {
      if (source.includes(repository)) {
        violations.push(`${file} 里写了镜像名 ${repository}：应当用 lib/agent-registry.mjs 从注册表读。`)
      }
    }
  }

  if (violations.length > 0) {
    log.error(`工具链脚本里出现了 agent 镜像名的字面量（${violations.length} 处）`)
    for (const violation of violations) console.log(`  ${violation}`)
    return false
  }

  log.success(`工具链脚本不维护镜像名（${files.length} 个文件，镜像名都在 ${REGISTRY_FILE}）`)
  return true
}

function checkNoSecondAgentList() {
  const ids = [...agentIds()]
  const files = collectFiles('packages').filter(
    (file) =>
      file.startsWith('packages/') &&
      /\/source\/.*\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      file !== REGISTRY_FILE,
  )
  const violations = []

  for (const file of files) {
    const found = agentIdsInCode(readFileSync(path.join(root, file), 'utf8'), ids)
    if (found.length >= 2) {
      violations.push(`${file} 同时列出了 ${found.join(' / ')}：agent 列表只该住在 ${REGISTRY_FILE}。`)
    }
  }

  if (violations.length > 0) {
    log.error(`发现了第二张 agent 表（${violations.length} 处）`)
    for (const violation of violations) console.log(`  ${violation}`)
    console.log('  要按 agent 区分的行为，请写成清单里的字段，而不是在代码里列 id。')
    return false
  }

  log.success(`agent 表只有一张（扫了 ${files.length} 个源码文件）`)
  return true
}

/**
 * 镜像定义在不在，与注册表说的必须一致。
 *
 * 拦的是「Dockerfile 写好了、版本忘了钉」这一种：注册表说 `unbuilt`、`images/`
 * 下却已经有那份定义，于是 `abx open <id>` 会拿 `仓库:unbuilt` 去起容器，
 * docker 报一句「拉不到镜像」——读起来像网络问题或者名字写错。
 *
 * 只判一个方向（有 Dockerfile ⇒ 不许是 unbuilt）。反方向**故意不在这里判**：
 * 「钉了版本却没有 Dockerfile」是构建脚本自己的事，它已经在第 1 步拒掉了
 * （exit 1，并说清该往哪儿放 Dockerfile）；而钉住的版本将来完全可能指向一个
 * 不是本地 `docker build` 出来的镜像，那时候这条规则会变成假警报。
 */
function checkImageVersionsMatchDockerfiles() {
  const withDockerfile = AGENT_DEFINITIONS.filter((agent) =>
    existsSync(path.join(root, IMAGES_DIR, agent.id, 'Dockerfile')),
  )
  const stale = withDockerfile.filter((agent) => agent.image.version === AGENT_IMAGE_UNBUILT)

  if (stale.length > 0) {
    log.error(`${IMAGES_DIR}/<id>/Dockerfile 存在、注册表里却还写着 unbuilt（${stale.length} 处）`)
    for (const agent of stale) {
      console.log(
        `  ${agent.id}：镜像定义已经在 ${IMAGES_DIR}/${agent.id}/Dockerfile，但 image.version 还是 ${AGENT_IMAGE_UNBUILT}。` +
          `把它改成实际装得上的版本，不然 abx open ${agent.id} 会拿 ${agent.image.repository}:${AGENT_IMAGE_UNBUILT} 去起容器。`,
      )
    }
    return false
  }

  const built = withDockerfile.map((agent) => `${agent.id}（${agent.image.version}）`)
  log.success(
    `镜像定义与注册表一致（${withDockerfile.length} 个 agent 有 Dockerfile${built.length > 0 ? `：${built.join(' / ')}` : ''}）`,
  )
  return true
}

log.title('Agent manifest check')

const checks = [checkManifest, checkNoImageLiterals, checkNoSecondAgentList, checkImageVersionsMatchDockerfiles]
const results = checks.map((check) => check())

if (results.some((passed) => !passed)) {
  log.error('Agent manifest check failed')
  process.exit(1)
}

log.success('Agent manifest is the single source')
