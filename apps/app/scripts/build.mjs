import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.ts'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
