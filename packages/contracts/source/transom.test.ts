import { describe, expect, it } from 'vitest'
import {
  AUTO_OPEN_EXTENSIONS,
  INLINE_PREVIEW_EXTENSIONS,
  MAX_DELIVERABLE_BYTES,
  NEVER_AUTO_OPEN_EXTENSIONS,
  TRANSOM_TOOL_NAMES,
  classifyDeliverable,
  formatBytes,
} from './transom'

/*
 * 这个文件守的是**传递窗唯一的那条红线**：「打开」不是「执行」。
 *
 * 所以断言的重点不是「png 能打开」这一半，而是另一半——**凡是没被点名的，一律不打开**。
 * 白名单判定与黑名单判定的差别在测试里也要能看出来：下面有一组「没人见过的后缀」，
 * 它们不在任何一张表里，处置必须是 reveal。
 */

describe('自动打开的白名单', () => {
  it('就是产品说的那几种，一个字都不多', () => {
    // 硬写一份在这里，是为了让「谁悄悄往白名单里加了一条」这件事**一定**会弄红一条测试。
    // 加白名单等于放松一道闸，它必须是一次有意识的、留下记录的改动。
    expect([...AUTO_OPEN_EXTENSIONS]).toEqual([
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'avif',
      'pdf',
      'txt',
      'md',
      'csv',
      'json',
      'log',
    ])
  })

  it('名单里每一条都真的会被打开', () => {
    for (const extension of AUTO_OPEN_EXTENSIONS) {
      const result = classifyDeliverable(`report.${extension}`)
      expect(result.disposition, `.${extension} 没被打开`).toBe('open')
      expect(result.extension).toBe(extension)
      expect(result.reason).toContain('白名单')
    }
  })

  it('大小写不敏感：REPORT.PNG 和 report.png 是同一个东西', () => {
    expect(classifyDeliverable('REPORT.PNG').disposition).toBe('open')
    expect(classifyDeliverable('Report.PdF').disposition).toBe('open')
    expect(classifyDeliverable('REPORT.PNG').extension).toBe('png')
  })
})

describe('白名单之外——一律只显示，不打开', () => {
  it('可执行文件与安装包逐条都只 reveal', () => {
    for (const extension of NEVER_AUTO_OPEN_EXTENSIONS) {
      const result = classifyDeliverable(`installer.${extension}`)
      expect(result.disposition, `.${extension} 被打开了`).toBe('reveal')
      // 理由必须点名「可执行/安装包」：用户看到的就这一句话，说得含糊等于没说。
      expect(result.reason).toContain('可执行文件或安装包')
    }
  })

  it('没有后缀的一律不打开', () => {
    const result = classifyDeliverable('notes')
    expect(result.disposition).toBe('reveal')
    expect(result.extension).toBe('')
    expect(result.reason).toContain('没有后缀')
  })

  it('前导点不是后缀：.env / .bashrc 都按「没有后缀」处理', () => {
    // 把 `.env` 读成「后缀是 env 的文件」，再有一条规则把 env 放进白名单，
    // 就是一次「把凭据文件当文本打开」的事故。这里把这条判据钉死。
    for (const name of ['.env', '.bashrc', '.gitconfig', '.']) {
      const result = classifyDeliverable(name)
      expect(result.extension, `${name} 被读出了后缀`).toBe('')
      expect(result.disposition).toBe('reveal')
    }
  })

  it('html / htm / svg 只 reveal，理由是「它能跑脚本」', () => {
    // 「绝不允许自动用系统浏览器打开 HTML」——这条断言就是那句话的机器版本。
    for (const name of ['report.html', 'report.htm', 'logo.svg']) {
      const result = classifyDeliverable(name)
      expect(result.disposition, `${name} 被打开了`).toBe('reveal')
      expect(result.reason).toContain('跑脚本')
      expect(result.reason).toContain('sandbox')
    }
  })

  it('没人见过的后缀也是 reveal——判定以白名单为准，不是黑名单', () => {
    // 这一组**故意**不在任何一张表里。黑名单判定在这里会全部翻车：
    // 它们不在「禁止」名单里，于是被判成可以打开。
    for (const name of ['deck.pptx', 'book.epub', 'archive.7z', 'thing.wasm', 'x.zyx']) {
      const result = classifyDeliverable(name)
      expect(result.disposition, `${name} 被打开了`).toBe('reveal')
      expect(result.reason).toContain('不在自动打开的白名单里')
    }
  })

  it('三张表互不重叠，白名单里也不许混进危险后缀', () => {
    const auto = new Set(AUTO_OPEN_EXTENSIONS)
    for (const extension of NEVER_AUTO_OPEN_EXTENSIONS) {
      expect(auto.has(extension), `.${extension} 同时出现在两张表里`).toBe(false)
    }
    for (const extension of INLINE_PREVIEW_EXTENSIONS) {
      expect(auto.has(extension), `.${extension} 同时是「自动打开」和「只能预览」`).toBe(false)
    }
    for (const extension of [...AUTO_OPEN_EXTENSIONS, ...NEVER_AUTO_OPEN_EXTENSIONS]) {
      expect(extension).toBe(extension.toLowerCase())
      expect(extension.startsWith('.')).toBe(false)
    }
  })
})

describe('文件名是怎么解析出来的', () => {
  it('取最后一段：给出的总是名字，不是整条路径', () => {
    expect(classifyDeliverable('/workspace/out/report.png').fileName).toBe('report.png')
    expect(classifyDeliverable('/workspace/out/report.png').disposition).toBe('open')
  })

  it('windows 风格的分隔符也切——文件名与它来自哪个平台无关', () => {
    expect(classifyDeliverable('C:\\Users\\dev\\report.pdf').fileName).toBe('report.pdf')
    expect(classifyDeliverable('C:\\Users\\dev\\report.pdf').disposition).toBe('open')
  })

  it('只剩一个后缀的怪名字不会让它抛', () => {
    // `report.` 的后缀是空串；`..png` 的前导点是 0 号位，也算没有后缀。
    expect(classifyDeliverable('report.').extension).toBe('')
    expect(classifyDeliverable('report.').disposition).toBe('reveal')
    expect(classifyDeliverable('..png').extension).toBe('png')
    expect(classifyDeliverable('').disposition).toBe('reveal')
  })

  it('.tar.gz 按最后一段判（gz），未知即 reveal', () => {
    expect(classifyDeliverable('backup.tar.gz').extension).toBe('gz')
    expect(classifyDeliverable('backup.tar.gz').disposition).toBe('reveal')
  })
})

describe('体积上限', () => {
  it('64 MiB——不是随手的数字，改它要连着改理由', () => {
    expect(MAX_DELIVERABLE_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_DELIVERABLE_BYTES).toBe(67_108_864)
  })
})

describe('formatBytes', () => {
  it('把字节数说成人话', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(70 * 1024 * 1024)).toBe('70.0 MiB')
  })
})

describe('工具面', () => {
  it('只有 publish 与 open 两个——这是产品承诺，不是当前进度', () => {
    // `http_fetch` / `run_shell` 这类东西是「永远不做」，不是「以后再做」。
    // 加工具时要改的就是这一行，改的时候总得看一眼这句注释。
    expect([...TRANSOM_TOOL_NAMES]).toEqual(['publish', 'open'])
  })
})
