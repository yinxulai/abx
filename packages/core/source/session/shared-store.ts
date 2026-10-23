/**
 * 共享列表的持久化：`~/.abx/shared.json`。
 *
 * 「拖进来的东西活过重启」靠的就是这一份文件。三件事决定了它的写法：
 *
 *   1. **列表住宿主侧，不住面板里。** 面板是个随时会被重建的窗口（失焦即隐藏、
 *      隐藏即不重建），把用户的共享列表放在它的内存里，等于每次重启都从头再来。
 *   2. **失效的条目标出来，不删。** 文件被删了/盘没挂上，是「现在挂不了」，
 *      不是「用户不要了」。abx 替用户把条目删掉，等于悄悄改他的东西；
 *      而界面上一行「已失效」既说清了现状，也把决定权留在他手里。
 *   3. **文件坏了不能让人打不开面板。** 读不动、JSON 坏了、记录不合法——
 *      一律跳过（最坏情况是空列表），而不是抛。共享列表是方便，不是数据。
 *      「跳过坏记录」与上面那条不冲突：那条说的是**条目失效**，这条说的是**文件本身**。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseSharedEntry, type SharedEntry, type SharedEntryState } from '@abx/contracts'
import { defaultInstancesRoot } from './instance'
import { inspectSharedEntry } from './shared'

/** 列表文件名。放在实例根**旁边**，与实例目录同级。 */
export const SHARED_LIST_FILE_NAME = 'shared.json'

/**
 * 共享列表落在哪儿：默认 `~/.abx/shared.json`。
 *
 * 与实例根同一个目录（`~/.abx/`），于是 `ABX_INSTANCES_ROOT` 一改，实例目录与这份
 * 列表一起搬走——测试和「把 abx 的数据放别的盘上」都只需要动一个变量。
 * 路径本身由宿主算（`apps/app/source/main.ts`），这个函数只是那个算法的唯一实现。
 */
export function defaultSharedListPath(env: Readonly<Record<string, string | undefined>> = process.env, homeDir: string = homedir()): string {
  return path.join(path.dirname(defaultInstancesRoot(env, homeDir)), SHARED_LIST_FILE_NAME)
}

/**
 * 读列表。
 *
 * 文件不在（第一次跑）给空数组；读不动、JSON 坏了、记录不合法也跳过——
 * 面板照常打开，只是少了几条。**不会**因为一个坏字节就抛。
 */
export function readSharedEntries(filePath: string): readonly SharedEntry[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const records = recordsOf(parsed)
  const entries: SharedEntry[] = []
  for (const record of records) {
    const result = parseSharedEntry(record)
    if (result.ok) entries.push(result.entry)
  }
  return entries
}

/**
 * 写列表。
 *
 * 先写临时文件再 `rename`：写到一半被打断（托盘应用被退出、机器休眠）时，
 * 坏的只会是那个临时文件，原来的列表还在。直接覆写的话，一次中断就等于
 * 用户的共享列表全没了——而这件事没有任何界面会告诉他。
 */
export function writeSharedEntries(filePath: string, entries: readonly SharedEntry[]): void {
  const directory = path.dirname(filePath)
  // 0700：里面是用户共享了哪些目录，是「他这台机器上有什么」的一份索引。
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const payload = `${JSON.stringify({ entries }, null, 2)}\n`
  const temporary = `${filePath}.tmp`
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, filePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * 把新条目并进已有列表，按路径去重：同一个文件拖两次只该有一条。
 *
 * 顺序是「老的在前、新的在后」，所以列表的次序就是用户加入的次序，重启也不会变。
 * 同一条路径第二次进来时以**新的**为准：kind 是宿主 stat 出来的，
 * 而新的那一次 stat 更近（文件变目录、目录变文件都可能）。
 */
export function addSharedEntries(existing: readonly SharedEntry[], incoming: readonly SharedEntry[]): readonly SharedEntry[] {
  const merged: SharedEntry[] = [...existing]
  for (const entry of incoming) {
    const index = merged.findIndex((candidate) => candidate.path === entry.path)
    if (index === -1) merged.push(entry)
    else merged[index] = entry
  }
  return merged
}

/**
 * 给每条条目标上「宿主上还在不在」，顺带用宿主现在的判断刷新 `kind`。
 *
 * 失效的条目**留在列表里**（`missing: true`），这是有意的：静默移除会让用户
 * 在完全不知情的情况下少共享一个目录，而他下次打开面板只会看到列表短了一截，
 * 没有任何线索说明为什么。要移除得由他自己按。
 */
export function markMissingEntries(entries: readonly SharedEntry[]): readonly SharedEntryState[] {
  return entries.map((entry) => {
    const present = inspectSharedEntry(entry.path)
    if (present === null) return { ...entry, missing: true }
    return { ...present, missing: false }
  })
}

/** 文件里那一层 `{ entries: [...] }`；形状不对就当没有。 */
function recordsOf(parsed: unknown): readonly unknown[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const entries = (parsed as { entries?: unknown }).entries
  return Array.isArray(entries) ? entries : []
}
