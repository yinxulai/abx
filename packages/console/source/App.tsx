import { AGENT_DEFINITIONS } from '@abx/contracts/agents'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { getBridge } from './bridge'
import { AgentStatusRow, type PanelAgent } from './components/AgentStatusRow'
import { DropZone } from './components/DropZone'
import { PanelCard } from './components/PanelCard'
import { useReportHeight } from './hooks/useReportHeight'

// 面板里那一排就是舱内能起的 agent，名字取自注册表（`@abx/contracts/agents`），
// 不在 UI 里再抄一份：加一个 agent 只该改注册表。
const PANEL_AGENTS: readonly PanelAgent[] = AGENT_DEFINITIONS.map((agent) => ({
  id: agent.id,
  label: agent.label,
}))

/** 从绝对路径里取文件名，兼容 POSIX 与 Windows 分隔符。 */
function fileName(filePath: string): string {
  const segments = filePath.split(/[\\/]/)
  return segments[segments.length - 1] ?? filePath
}

export function App() {
  const cardRef = useRef<HTMLElement | null>(null)
  const [runningIds, setRunningIds] = useState<readonly string[]>([])
  const [sharedPaths, setSharedPaths] = useState<readonly string[]>([])
  const [dragging, setDragging] = useState(false)

  useReportHeight(cardRef)

  useEffect(() => {
    const bridge = getBridge()
    if (bridge === undefined) return
    // 落下的路径由 preload 抽出后回调过来；这里只负责显示，挂载是另一个作业。
    return bridge.onDroppedFiles((paths) => {
      setSharedPaths((current) => {
        const merged = [...current]
        for (const path of paths) {
          if (!merged.includes(path)) merged.push(path)
        }
        return merged
      })
    })
  }, [])

  const startAgent = useCallback((agentId: string) => {
    // 宿主还没有会话 IPC，这一步只翻转指示器，让按钮真的可操作；
    // 接上 `session.create` 由会话作业负责（见 tray-ui.md §5）。
    setRunningIds((current) => (current.includes(agentId) ? current : [...current, agentId]))
  }, [])

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    // 不 preventDefault，浏览器会把拖入当成导航，drop 根本不会派发。
    event.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>): void => {
    // 指针在卡片内部的元素之间移动也会触发 dragleave，只有真的离开卡片才算放下高亮。
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDragging(false)
  }

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragging(false)
  }

  return (
    <PanelCard
      runningCount={runningIds.length}
      dragging={dragging}
      cardRef={cardRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <AgentStatusRow agents={PANEL_AGENTS} runningIds={runningIds} onStart={startAgent} />

      <section className="abx-section" aria-labelledby="abx-shared-title">
        <div className="abx-section-head">
          <h2 className="abx-section-title" id="abx-shared-title">
            共享给全部 agent
          </h2>
          <span className="abx-section-count">{sharedPaths.length} 项</span>
        </div>

        {sharedPaths.length > 0 && (
          <ul className="abx-list" aria-label="共享条目">
            {sharedPaths.map((path) => (
              <li className="abx-list-row" key={path}>
                <span className="abx-list-icon" aria-hidden="true">
                  ▤
                </span>
                <span className="abx-list-name" title={path}>
                  {fileName(path)}
                </span>
                {/* 第一版只有只读条目；可写条目来了换徽标，不换布局。 */}
                <span className="abx-badge">只读</span>
              </li>
            ))}
          </ul>
        )}

        <DropZone hasEntries={sharedPaths.length > 0} dragging={dragging} />
      </section>
    </PanelCard>
  )
}
