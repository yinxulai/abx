/**
 * 舱令牌的格式。
 *
 * 这里验的是**加了前缀之后一切照旧**：令牌要能被扫描到（前缀），要还是随机的
 * （32 字节），并且其余那些只看字符串的地方（请求头、路径前缀、令牌文件、注册表）
 * 一个都不因此失效——它们的逻辑本来就跟格式无关，但「本来」两个字得有用例撑着。
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CellTokenRegistry } from './registry'
import { CELL_PATH_PREFIX, extractCellToken } from './route'
import {
  CELL_TOKEN_FILE_NAME,
  CELL_TOKEN_PREFIX,
  defaultCellTokenPath,
  generateCellToken,
  readCellTokenFile,
  writeCellTokenFile,
} from './token'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'abx-token-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('generateCellToken', () => {
  it('带可扫描的前缀', () => {
    const token = generateCellToken()

    expect(token.startsWith(CELL_TOKEN_PREFIX)).toBe(true)
    expect(CELL_TOKEN_PREFIX).toBe('abx_cell_')
  })

  it('前缀之后还是 32 字节随机值', () => {
    const token = generateCellToken()

    expect(token.slice(CELL_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('每次都不一样', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCellToken()))
    expect(tokens.size).toBe(50)
  })

  it('前缀是常量，不是散在代码里的字符串', () => {
    // 生成出来的令牌必须正好是这个常量 + 一段 hex；也就是说调用方只要引用
    // CELL_TOKEN_PREFIX 就一定能拼对，不需要在别处再写一遍。
    const token = generateCellToken()
    expect(token).toBe(`${CELL_TOKEN_PREFIX}${token.slice(CELL_TOKEN_PREFIX.length)}`)
  })

  it('前缀本身不是信任标记：没登记过的带前缀令牌一样查不到', () => {
    const registry = new CellTokenRegistry()
    expect(registry.resolve(generateCellToken())).toBeNull()
  })
})

describe('带前缀的令牌照样走通各处', () => {
  it('放请求头里能取出来', () => {
    const token = generateCellToken()
    const extraction = extractCellToken(
      { pathname: '/u/anthropic/v1/messages', headers: { 'x-abx-cell': token } },
      { allowInPath: true },
    )

    expect(extraction).toMatchObject({ token, source: 'header', pathname: '/u/anthropic/v1/messages' })
  })

  it('放 /c/ 路径前缀里能取出来，且前缀被剥干净', () => {
    const token = generateCellToken()
    const extraction = extractCellToken(
      { pathname: `${CELL_PATH_PREFIX}${token}/u/anthropic/v1/messages`, headers: {} },
      { allowInPath: true },
    )

    expect(extraction).toMatchObject({ token, source: 'path', pathname: '/u/anthropic/v1/messages' })
  })

  it('注册表里存进去、反查得出来', () => {
    const registry = new CellTokenRegistry()
    const token = registry.register('cell-a')

    expect(token.startsWith(CELL_TOKEN_PREFIX)).toBe(true)
    expect(registry.resolve(token)).toBe('cell-a')
  })

  it('落盘再读回来是同一个值', () => {
    const directory = temporaryDirectory()
    const filePath = defaultCellTokenPath(path.join(directory, 'audit.jsonl'))
    const token = generateCellToken()

    expect(path.basename(filePath)).toBe(CELL_TOKEN_FILE_NAME)
    writeCellTokenFile(filePath, token)

    expect(readCellTokenFile(filePath)).toBe(token)
    // 落盘的就是令牌本身，前后没有多出别的字符（读回来时 trim 掉的只有换行）。
    expect(readFileSync(filePath, 'utf8').trim()).toBe(token)
    // 令牌文件是这次会话的凭据，权限不能放宽。
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })
})
