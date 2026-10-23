import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CELL_PATH,
  cellBasename,
  cellDirname,
  cellHomePath,
  cellJoin,
  isCellAbsolute,
  isCellAncestor,
  isUnderCellPath,
} from './cell-path'

/**
 * 这份测试在**任何**宿主上跑，期望值都一样——那正是这个模块要保证的事。
 *
 * 所以这里没有一处 `process.platform`，也没有一处 `if (win32)`：舱内路径与宿主
 * 是什么系统无关。凡是需要分平台的地方，说明那一处又把两种路径混起来了。
 */

const CELL_HOME = '/home/node'

describe('CELL_PATH', () => {
  it('永远是 posix，不跟着宿主走', () => {
    expect(CELL_PATH).toBe(path.posix)
    expect(CELL_PATH.sep).toBe('/')
  })

  it('与宿主语义是两种东西：win32 的拼法拼不出舱内路径', () => {
    // 这就是 `\home\node\.claude` 那个 bug 的最小形态。断言同时钉住了两件事：
    // 舱内这一半永远拼对，以及宿主那一半在 Windows 上确实会拼错——所以两者不能混。
    expect(CELL_PATH.join('/home', 'node', '.claude')).toBe('/home/node/.claude')
    expect(path.win32.join('/home', 'node', '.claude')).toBe('\\home\\node\\.claude')
  })
})

describe('cellHomePath', () => {
  it('`~` 展开成舱内 home，展开出来的是 posix 路径', () => {
    expect(cellHomePath('~/.claude/settings.json', CELL_HOME)).toBe('/home/node/.claude/settings.json')
    expect(cellHomePath('~/.codex/config.toml', CELL_HOME)).toBe('/home/node/.codex/config.toml')
  })

  it('`~` 单独一个就是 home 本身', () => {
    expect(cellHomePath('~', CELL_HOME)).toBe('/home/node')
  })

  it('不写 `~` 的路径原样返回，不做任何平台相关的加工', () => {
    expect(cellHomePath('/workspace/notes.md', CELL_HOME)).toBe('/workspace/notes.md')
    expect(cellHomePath('/etc/hosts', CELL_HOME)).toBe('/etc/hosts')
  })

  it('`~` 只认开头那一个，别处的波浪号是普通字符', () => {
    // `~other/file` 与 `a~b/file` 都不是 home 展开，原样留着——多展开一处就等于
    // 悄悄改了一条 agent 自己写的路径。
    expect(cellHomePath('~other/file', CELL_HOME)).toBe('~other/file')
    expect(cellHomePath('/tmp/a~b/file', CELL_HOME)).toBe('/tmp/a~b/file')
  })

  it('展开的位置来自参数，不是宿主的 home', () => {
    // 舱内 home 与宿主 home 是两回事：镜像换了 uid、或者用户改了 `session.cellHome`，
    // 展开点就得跟着变。这一条钉的是「它没有偷偷去读 os.homedir()」。
    expect(cellHomePath('~/.claude', '/root')).toBe('/root/.claude')
    expect(cellHomePath('~/.claude', '/home/agent')).toBe('/home/agent/.claude')
  })
})

describe('舱内路径的判定', () => {
  it('绝对性按 posix 判，不按宿主判', () => {
    expect(isCellAbsolute('/home/node/.claude')).toBe(true)
    expect(isCellAbsolute('/workspace')).toBe(true)
    // Windows 写法的路径**不是**合法的舱内路径——反过来也一样，容器里没有盘符。
    expect(isCellAbsolute('C:\\Users\\dev')).toBe(false)
    expect(isCellAbsolute('\\home\\node')).toBe(false)
    expect(isCellAbsolute('relative/path')).toBe(false)
  })

  it('上下级关系按 posix 的分隔符判', () => {
    expect(isUnderCellPath('/home/node/.claude', '/home/node')).toBe(true)
    expect(isUnderCellPath('/home/node', '/home/node')).toBe(true)
    expect(isUnderCellPath('/home/other/.claude', '/home/node')).toBe(false)
    // 前缀边界：`/home/nodely` 不在 `/home/node` 下面。
    expect(isUnderCellPath('/home/nodely', '/home/node')).toBe(false)
    expect(isCellAncestor('/home/node', '/home/node/.claude')).toBe(true)
    expect(isCellAncestor('/home/node', '/home/node')).toBe(false)
  })

  it('共享区那一层的形状判定', () => {
    expect(cellDirname('/shared/notes')).toBe('/shared')
    expect(cellDirname('/shared/notes/inner')).toBe('/shared/notes')
    expect(cellJoin('/shared', 'notes')).toBe('/shared/notes')
  })

  it('最后一段', () => {
    expect(cellBasename('/home/node/.claude/settings.json')).toBe('settings.json')
    expect(cellBasename('/home/node/.claude')).toBe('.claude')
    // 反斜杠在舱内不是分隔符，所以整串都是「最后一段」。
    expect(cellBasename('\\home\\node\\.claude')).toBe('\\home\\node\\.claude')
  })
})
