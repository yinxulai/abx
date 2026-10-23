import type { SharedEntry, SharedEntryKind, SharedListSnapshot } from '@abx/contracts'
import { AGENT_DEFINITIONS } from '@abx/contracts/agents'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { getBridge } from './bridge'
import { AgentStatusRow, type PanelAgent } from './components/AgentStatusRow'
import { DropZone } from './components/DropZone'
import { PanelCard } from './components/PanelCard'
import { SharedRejectionList } from './components/SharedRejectionList'
import { fileName } from './file-name'
import { useReportHeight } from './hooks/useReportHeight'

// 面板里那一排就是舱内能起的 agent，名字取自注册表（`@abx/contracts/agents`），
// 不在 UI 里再抄一份：加一个 agent 只该改注册表。
const PANEL_AGENTS: readonly PanelAgent[] = AGENT_DEFINITIONS.map((agent) => ({
  id: agent.id,
  label: agent.label,
}))

/** 宿主还没答话时的空态。 */
const EMPTY_SNAPSHOT: SharedListSnapshot = { entries: [], rejected: [] }

/**
 * 一行条目的状态。
 *
 * `pending` 与 `ready` 的区别是**谁说了算**：`pending` 是拖放时浏览器给的预览
 * （`webkitGetAsEntry()`），`ready` 是宿主 stat 完之后给的结论。预览只是为了图标
 * 立刻出现，它不写进任何持久化文件，也不该被当成「已经共享了」。
 */
type SharedRowState = 'ready' | 'missing' | 'pending'

interface SharedRow {
  readonly path: string
  readonly kind: SharedEntryKind
  readonly state: SharedRowState
}

/**
 * 图标：文件保持原来的 `▤`，目录用 `◰`——方块里带一个左上角的小块，
 * 是这一堆几何符号里最接近「文件夹」轮廓的那个。**不引图标库**：
 * 面板只有这一处用得上图标，为它添一个依赖不划算。
 */
const KIND_ICON: Record<SharedEntryKind, string> = { file: '▤', directory: '◰' }
const KIND_LABEL: Record<SharedEntryKind, string> = { file: '文件', directory: '目录' }

/**
 * 徽标。能挂上的都是只读，挂载模式没变；
 * 「加入中」与「已失效」必须单独说——这两种状态下条目还没有用或者已经没用了，
 * 混在「只读」里会让人以为它已经生效。
 */
const STATE_BADGE: Record<SharedRowState, string> = {
  ready: '只读',
  missing: '已失效',
  pending: '加入中',
}

export function App() {
  const cardRef = useRef<HTMLElement | null>(null)
  const [runningIds, setRunningIds] = useState<readonly string[]>([])
  const [snapshot, setSnapshot] = useState<SharedListSnapshot>(EMPTY_SNAPSHOT)
  const [preview, setPreview] = useState<readonly SharedEntry[]>([])
  const [dragging, setDragging] = useState(false)

  useReportHeight(cardRef)

  useEffect(() => {
    const bridge = getBridge()
    if (bridge === undefined) return

    // 一次拖放会分两步到达：先预览（图标立刻出现），再快照（宿主 stat 与闸门之后的结论）。
    const stopPreview = bridge.onDroppedEntries((entries) => setPreview(entries))
    const stopSnapshot = bridge.onSharedList((next) => {
      setSnapshot(next)
      // 快照一到预览整批退场：进没进列表由宿主说了算，预览不许赖着不走
      // （被拒的条目要是留在列表里，就成了「看着共享了、其实没有」）。
      setPreview([])
    })
    // 每次挂载都问一次：条目可能被删、可能被别处改过，名单不能靠上次那份缓存。
    bridge.requestSharedList()

    return () => {
      stopPreview()
      stopSnapshot()
    }
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

  // 宿主那几行在前（持久化的次序，稳定），预览垫在后面。
  const rows: readonly SharedRow[] = [
    ...snapshot.entries.map(
      (entry): SharedRow => ({ path: entry.path, kind: entry.kind, state: entry.missing ? 'missing' : 'ready' }),
    ),
    ...preview
      .filter((entry) => !snapshot.entries.some((known) => known.path === entry.path))
      .map((entry): SharedRow => ({ path: entry.path, kind: entry.kind, state: 'pending' })),
  ]

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
          <span className="abx-section-count">{rows.length} 项</span>
        </div>

        {rows.length > 0 && (
          <ul className="abx-list" aria-label="共享条目">
            {rows.map((row) => (
              <li className="abx-list-row" key={row.path} data-state={row.state}>
                {/* 图标带的是「文件还是目录」这条信息，交给读屏；kind 一律来自宿主。 */}
                <span className="abx-list-icon" role="img" aria-label={KIND_LABEL[row.kind]}>
                  {KIND_ICON[row.kind]}
                </span>
                <span className="abx-list-name" title={row.path}>
                  {fileName(row.path)}
                </span>
                <span className="abx-badge">{STATE_BADGE[row.state]}</span>
              </li>
            ))}
          </ul>
        )}

        {/* 没进来的那几条不进列表，原因写在共享区下面。 */}
        <SharedRejectionList rejected={snapshot.rejected} />

        <DropZone hasEntries={rows.length > 0} dragging={dragging} />
      </section>
    </PanelCard>
  )
}
