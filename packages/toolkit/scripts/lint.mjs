import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/log.mjs'
import { run } from './lib/run.mjs'

// 一条命令跑完全部静态检查。检查项各自住在本包里，所以这里只做编排。
// 工作目录钉死在仓库根，不依赖调用方从哪里执行。
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const main = async () => {
  log.title('Linting')
  try {
    // `--cache` 只跳过「内容与配置都没变」的文件，缓存过期最多是多跑一遍；
    // 位置放进 node_modules/.cache 而不是仓库根，免得 `.eslintcache` 变成常驻的未跟踪文件。
    await run('pnpm', ['exec', 'eslint', '.', '--cache', '--cache-location', 'node_modules/.cache/eslintcache'], {
      cwd: repositoryRoot,
    })
    await run(process.execPath, ['packages/toolkit/scripts/check-package-boundaries.mjs'], { cwd: repositoryRoot })
    // agent 清单是「一个 agent = 一条数据」的唯一来源：自洽性、脚本里不许再写镜像名、
    // 不许出现第二张 agent 表。判据与单测共用 `agentManifestProblems()`。
    await run(process.execPath, ['packages/toolkit/scripts/check-agent-manifest.mjs'], { cwd: repositoryRoot })
    // 版本号写在仓库根与每一个 workspace 包的 manifest 里。这里只读校验，
    // 与根不一致就直接失败——「哪一份 manifest 忘了改」不该等到发布之后靠人回头看。
    await run(process.execPath, ['packages/toolkit/scripts/version.mjs', '--check'], { cwd: repositoryRoot })
    log.success('Lint passed')
  } catch (error) {
    log.error('Lint failed')
    process.exit(1)
  }
}

main()
