import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/log.mjs'
import { run } from './lib/run.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const main = async () => {
  const args = process.argv.slice(2)
  const coverage = args.includes('--coverage')
  log.title(coverage ? 'Running tests with coverage' : 'Running tests')
  try {
    await run('pnpm', ['exec', 'vitest', 'run', '--config', 'packages/toolkit/vitest.config.ts', ...args], {
      cwd: repositoryRoot,
    })
    log.success('All tests passed')
  } catch (error) {
    log.error('Tests failed')
    process.exit(1)
  }
}

main()
