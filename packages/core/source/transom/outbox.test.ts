/**
 * 交付格的用例。
 *
 * 三条规矩各有一组：**落点写死**、**永不覆盖**、**超限就拒并且不留残骸**。
 * 另外把「复制出来的字节与来源逐字节相同、sha256 也对得上」钉死——那是整个传递窗
 * 唯一一次真的搬字节的地方，它错了的话，后面所有「打开看看」都建立在坏文件上。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_DELIVERABLE_BYTES } from '@abx/contracts'
import { RUNNING_VOCABULARY } from '../test-support'
import { OUTBOX_DIR_NAME, OUTBOX_ROOT_ENV, defaultOutboxRoot, deliverToOutbox, outboxDirFor, sanitizeSegment } from './outbox'

/** 交付根是**宿主路径**，所以形状跟着跑测试这台机器走（见 `test-support.ts`）。 */
const HOST = RUNNING_VOCABULARY

const directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

function tempDir(prefix = 'abx-outbox-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function ok(result: Awaited<ReturnType<typeof deliverToOutbox>>) {
  if (!result.ok) throw new Error(`本来该成功，却被拒了：${result.reason}`)
  return result.file
}

function reasonOf(result: Awaited<ReturnType<typeof deliverToOutbox>>): string {
  if (result.ok) throw new Error('本来该被拒，却成功了')
  return result.reason
}

describe('交付根与交付格的位置', () => {
  it('默认是 ~/.abx/outbox', () => {
    expect(defaultOutboxRoot({}, HOST.home)).toBe(HOST.underHome('.abx', OUTBOX_DIR_NAME))
  })

  it('环境变量能覆盖它——用例不能往开发者真实的 ~/.abx 里写', () => {
    const custom = HOST.underHome('custom-outbox')
    expect(defaultOutboxRoot({ [OUTBOX_ROOT_ENV]: custom }, HOST.home)).toBe(custom)
    expect(defaultOutboxRoot({ [OUTBOX_ROOT_ENV]: '  ' }, HOST.home)).toBe(HOST.underHome('.abx', OUTBOX_DIR_NAME))
  })

  it('一格一个会话：路径里带上 cellId', () => {
    const root = HOST.underHome('.abx', OUTBOX_DIR_NAME)
    expect(outboxDirFor(root, 'claude-20261023-abc123')).toBe(HOST.join(root, 'claude-20261023-abc123'))
  })

  it('会话 id 里带 / 或 .. 也逃不出交付根', () => {
    // cellId 是 broker 按令牌解出来的，正常情况干净得很；但这一段是**路径拼接**，
    // 拼接处永远要假设输入是脏的。
    expect(sanitizeSegment('../../etc', 'cell')).toBe('.._.._etc')
    expect(outboxDirFor(HOST.home, '../../etc')).toBe(HOST.join(HOST.home, '.._.._etc'))
    expect(sanitizeSegment('', 'cell')).toBe('cell')
    expect(sanitizeSegment('..', 'cell')).toBe('cell')
  })

  it('文件名清洗：分隔符与控制字符换掉，超长保留后缀', () => {
    expect(sanitizeSegment('a/b.md', 'delivered')).toBe('a_b.md')
    expect(sanitizeSegment('a\nb.md', 'delivered')).toBe('a_b.md')
    expect(sanitizeSegment('.env', 'delivered')).toBe('.env')
    const long = sanitizeSegment(`${'x'.repeat(300)}.pdf`, 'delivered')
    expect(long.length).toBe(128)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})

describe('复制：字节与哈希都对得上', () => {
  it('落到交付格里的内容与来源逐字节相同，sha256 就是来源的 sha256', async () => {
    const base = tempDir()
    const source = path.join(base, 'report.md')
    const content = '# 报告\n\n内容里有中文与换行。\n'
    writeFileSync(source, content)

    const file = ok(
      await deliverToOutbox({ sourcePath: source, fileName: 'report.md', directory: path.join(base, 'outbox', 'cell-1') }),
    )
    expect(file.hostPath).toBe(path.join(base, 'outbox', 'cell-1', 'report.md'))
    expect(readFileSync(file.hostPath, 'utf8')).toBe(content)
    expect(file.bytes).toBe(Buffer.byteLength(content))
    expect(file.sha256).toBe(sha256Of(content))
    expect(file.renamed).toBe(false)
  })

  it('二进制内容也不会被当成文本动过', async () => {
    const base = tempDir()
    const source = path.join(base, 'blob.bin')
    const content = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x0d, 0x80])
    writeFileSync(source, content)

    const file = ok(await deliverToOutbox({ sourcePath: source, fileName: 'blob.bin', directory: path.join(base, 'o') }))
    expect(readFileSync(file.hostPath)).toEqual(content)
    expect(file.sha256).toBe(sha256Of(content))
  })

  it('交付格不存在时会建出来', async () => {
    const base = tempDir()
    const source = path.join(base, 'a.txt')
    writeFileSync(source, 'x')
    const directory = path.join(base, 'deep', 'nested', 'cell-1')

    ok(await deliverToOutbox({ sourcePath: source, fileName: 'a.txt', directory }))
    expect(existsSync(path.join(directory, 'a.txt'))).toBe(true)
  })
})

describe('永不覆盖：重名就改名', () => {
  it('第二次递同一个名字，落到 report-2.md，第一份一个字节都没变', async () => {
    const base = tempDir()
    const directory = path.join(base, 'outbox', 'cell-1')
    const first = path.join(base, 'first.md')
    const second = path.join(base, 'second.md')
    writeFileSync(first, '第一次')
    writeFileSync(second, '第二次')

    const one = ok(await deliverToOutbox({ sourcePath: first, fileName: 'report.md', directory }))
    const two = ok(await deliverToOutbox({ sourcePath: second, fileName: 'report.md', directory }))

    expect(one.fileName).toBe('report.md')
    expect(two.fileName).toBe('report-2.md')
    expect(two.renamed).toBe(true)
    // 第一份还在，而且内容没被动过——「覆盖」是这里唯一不能出的错。
    expect(readFileSync(one.hostPath, 'utf8')).toBe('第一次')
    expect(readFileSync(two.hostPath, 'utf8')).toBe('第二次')
  })

  it('后缀留在最后：改名之后系统还认得出它是什么', async () => {
    const base = tempDir()
    const directory = path.join(base, 'o')
    const source = path.join(base, 's.png')
    writeFileSync(source, 'x')
    writeFileSync(path.join(base, 'occupied'), '')

    ok(await deliverToOutbox({ sourcePath: source, fileName: 'shot.png', directory }))
    const second = ok(await deliverToOutbox({ sourcePath: source, fileName: 'shot.png', directory }))
    expect(second.fileName).toBe('shot-2.png')
    expect(path.extname(second.fileName)).toBe('.png')
  })

  it('同名很多次也不会写乱：每次都换一个新名字', async () => {
    const base = tempDir()
    const directory = path.join(base, 'o')
    const source = path.join(base, 's.txt')
    writeFileSync(source, 'x')

    const names: string[] = []
    for (let index = 0; index < 4; index += 1) {
      names.push(ok(await deliverToOutbox({ sourcePath: source, fileName: 'log.txt', directory })).fileName)
    }
    expect(names).toEqual(['log.txt', 'log-2.txt', 'log-3.txt', 'log-4.txt'])
    expect(readdirSync(directory).sort()).toEqual(['log-2.txt', 'log-3.txt', 'log-4.txt', 'log.txt'])
  })

  it('没有后缀的文件重名时照样改名', async () => {
    const base = tempDir()
    const directory = path.join(base, 'o')
    const source = path.join(base, 'notes')
    writeFileSync(source, 'x')

    ok(await deliverToOutbox({ sourcePath: source, fileName: 'notes', directory }))
    expect(ok(await deliverToOutbox({ sourcePath: source, fileName: 'notes', directory })).fileName).toBe('notes-2')
  })
})

describe('体积上限：拒绝，并且不留残骸', () => {
  it('来源本来就超限 → 立刻拒，报出多大、上限多少', async () => {
    const base = tempDir()
    const source = path.join(base, 'big.bin')
    writeFileSync(source, '')
    truncateSync(source, MAX_DELIVERABLE_BYTES + 1)

    const reason = reasonOf(await deliverToOutbox({ sourcePath: source, fileName: 'big.bin', directory: path.join(base, 'o') }))
    expect(reason).toContain('64.0 MiB')
    expect(reason).toContain('超过了单次交付的上限')
    expect(existsSync(path.join(base, 'o', 'big.bin'))).toBe(false)
  })

  it('来源不存在 → 拒绝，理由说得出是哪种错', async () => {
    const base = tempDir()
    const reason = reasonOf(
      await deliverToOutbox({ sourcePath: path.join(base, 'nope.md'), fileName: 'nope.md', directory: path.join(base, 'o') }),
    )
    expect(reason).toContain('读不到来源文件')
    expect(reason).toContain('它不存在')
  })
})
