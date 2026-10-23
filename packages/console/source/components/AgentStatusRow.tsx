export interface PanelAgent {
  readonly id: string
  readonly label: string
}

export interface AgentStatusRowProps {
  readonly agents: readonly PanelAgent[]
  /** 正在跑的 agent id。 */
  readonly runningIds: readonly string[]
  readonly onStart: (agentId: string) => void
}

/**
 * 一排 agent 方块，**既是状态指示也是启动按钮**。
 *
 * 两者不分开：实心方块表示这个 agent 有舱在跑，点它则是起一个新舱（已在跑时不重复触发）。
 * 面板里没有菜单、没有二级页，所以「状态」和「动作」落在同一个可聚焦元素上是刻意的——
 * 用一个只读图标表示状态、再在旁边放一个小按钮，等于让用户去猜哪个能点。
 */
export function AgentStatusRow(props: AgentStatusRowProps) {
  return (
    <div className="abx-agents" role="group" aria-label="agent 状态">
      {props.agents.map((agent) => {
        const running = props.runningIds.includes(agent.id)
        const action = running ? '运行中' : '未运行，点击启动'
        return (
          <button
            key={agent.id}
            type="button"
            className="abx-agent"
            data-running={running}
            // 状态走 `aria-pressed` 而不是靠颜色/实心：色觉差异与读屏用户同样要能判断。
            aria-pressed={running}
            aria-label={`${agent.label}：${action}`}
            title={agent.label}
            onClick={() => {
              if (!running) props.onStart(agent.id)
            }}
          >
            <span className="abx-agent-square" aria-hidden="true">
              {agent.label.slice(0, 1)}
            </span>
            <span className="abx-agent-name">{agent.label}</span>
          </button>
        )
      })}
    </div>
  )
}
