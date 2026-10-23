// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { firstSentence, SharedRejectionList } from './SharedRejectionList'

afterEach(cleanup)

describe('firstSentence', () => {
  it('只取到第一个句号', () => {
    expect(firstSentence('目录里有凭据文件：notes/.env 命中 *.env。整段拒绝的理由在后面。')).toBe(
      '目录里有凭据文件：notes/.env 命中 *.env。',
    )
  })

  it('没有句号就整句留下——宁可长一点，也不能把原因吞了', () => {
    expect(firstSentence('路径是空的')).toBe('路径是空的')
  })
})

describe('SharedRejectionList', () => {
  it('没被拒的条目就不占地方', () => {
    const { container } = render(<SharedRejectionList rejected={[]} />)
    expect(container.textContent).toBe('')
  })

  it('逐条列出「是谁、为什么」，完整那句留在 title 里', () => {
    render(
      <SharedRejectionList
        rejected={[
          {
            path: '/Users/alain/notes/.credentials.json',
            reason: '这是凭据文件（命中规则 .credentials.json）：舱内永远拿不到真凭据。',
          },
        ]}
      />,
    )

    expect(screen.getByText('1 项未加入共享区')).toBeTruthy()
    expect(screen.getByText('.credentials.json').getAttribute('title')).toBe('/Users/alain/notes/.credentials.json')
    const reason = screen.getByText('这是凭据文件（命中规则 .credentials.json）：舱内永远拿不到真凭据。')
    expect(reason.getAttribute('title')).toBe('这是凭据文件（命中规则 .credentials.json）：舱内永远拿不到真凭据。')
  })
})
