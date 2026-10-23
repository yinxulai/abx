// 从 agent 注册表里读镜像信息，给 shell 脚本用。
//
// 为什么要有这一层：镜像名与版本只能有一个来源，就是
// `packages/contracts/source/agents.ts`。构建脚本里再写一遍仓库名和版本号，
// 两处迟早只改到一处——那时镜像是 A、标签是 B，而「标签说一个版本、里面其实是
// 另一个」正是最难查的那种不一致。
//
// 直接 import `.ts`：Node 24 原生剥离类型（engines 要求 >=24），而 agents.ts
// 没有任何 import，所以不需要 loader、不需要先编译。
//
// 用法（shell 里取一个字段）：
//   node packages/toolkit/scripts/lib/agent-registry.mjs <agent> repository  # 仓库名
//   node packages/toolkit/scripts/lib/agent-registry.mjs <agent> version     # 注册表里钉的版本
//   node packages/toolkit/scripts/lib/agent-registry.mjs <agent> ref         # 仓库名:版本
//   node packages/toolkit/scripts/lib/agent-registry.mjs <agent> local-ref   # 仓库名:local
//
// 退出码：0 = 打印了一个值；1 = 不认识的 agent；2 = 用法不对。

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const registryPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'packages/contracts/source/agents.ts',
)

/** 载入注册表模块本身（`findAgent` / `AGENT_DEFINITIONS` / `agentImageRef`）。 */
export async function loadAgentRegistry() {
  return import(pathToFileURL(registryPath).href)
}

const FIELDS = {
  repository: (agent) => agent.image.repository,
  version: (agent) => agent.image.version,
  ref: (agent, { agentImageRef }) => agentImageRef(agent),
  'local-ref': (agent) => `${agent.image.repository}:local`,
}

const FIELD_NAMES = Object.keys(FIELDS)

const main = async () => {
  const [agentId, field] = process.argv.slice(2)
  if (agentId === undefined || field === undefined) {
    process.stderr.write(`用法：agent-registry.mjs <agent> <${FIELD_NAMES.join('|')}>\n`)
    process.exit(2)
  }

  const readField = FIELDS[field]
  if (readField === undefined) {
    process.stderr.write(`不认识的字段：${field}。可用的是 ${FIELD_NAMES.join(' / ')}。\n`)
    process.exit(2)
  }

  const registry = await loadAgentRegistry()
  const agent = registry.findAgent(agentId)
  if (agent === null) {
    process.stderr.write(
      `注册表里没有 agent ${JSON.stringify(agentId)}。当前有：${registry.agentIds().join(' / ')}。\n`,
    )
    process.exit(1)
  }

  process.stdout.write(`${readField(agent, registry)}\n`)
}

// 只在被当作脚本执行时跑 CLI：别的脚本 import 它是为了拿 `loadAgentRegistry()`，
// 不该顺带把一次「用法不对」的退出码带过去。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
