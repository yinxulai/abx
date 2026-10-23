import type { CSSProperties } from 'react'
import type { AgentIcon } from '@abx/contracts'

export interface PanelAgent {
  readonly id: string
  readonly label: string
  /**
   * 注册表里的图标（标识 + 可选品牌色）。**可选**：没有的 agent 什么都不用写，
   * 方块回退到 `label` 的第一个字。图形资产属于界面层，所以这里只拿标识与颜色。
   */
  readonly icon?: AgentIcon
}

export interface AgentStatusRowProps {
  readonly agents: readonly PanelAgent[]
  /** 正在跑的 agent id。 */
  readonly runningIds: readonly string[]
  readonly onStart: (agentId: string) => void
}

/**
 * 一个方块的**两种**状态。状态表来自 `apps/docs/specs/product/tray-ui.md` §4，
 * 与它一一对应；样式在 `styles.css` 里按 `data-state` 各写一段
 * （两段的差别是线的样式与标记形状，不只是颜色）。
 *
 * **没有第三档。** 托盘里只放已安装的 agent（`tray-ui.md` §3.1 ④）：一个图标代表不了
 * 还没装的 agent——它既没有可辨认的身份，也没有可执行的动作。所以镜像还没构建的 agent
 * 根本不进这一排（过滤在 `App.tsx`）；「不可用」那一档属于管理面板，不属于这里。
 *
 * 用联合类型而不是几个布尔：布尔能表达出「没构建**并且**在跑」这种没有意义的状态，
 * 联合类型不能。
 */
type AgentTileState = 'running' | 'idle'

/**
 * 状态怎么**说**：用动作词，不用形容词（`design-system.md` §12：「未运行」写「启动」）。
 *
 * 这句话有两个出口——tile 的 `aria-label`，以及悬停/键盘聚焦时出现的 tooltip——
 * 所以只写一份。两处读同一个字符串，改文案不会只改到一半。
 */
const STATE_TEXT: Readonly<Record<AgentTileState, string>> = {
  running: '运行中，点击聚焦',
  idle: '未运行，点击启动',
}

/** tile 的完整读法：`名字 · 状态`。视觉上省掉的名字，在这里补回来。 */
function tileText(agent: PanelAgent, state: AgentTileState): string {
  return `${agent.label} · ${STATE_TEXT[state]}`
}

/**
 * 一排 agent 方块，**既是状态指示也是启动按钮**。
 *
 * 两者不分开：点它是起一个新舱，tooltip 里的动作词直接把这个动作写出来。面板里没有菜单、
 * 没有二级页，所以「状态」和「动作」落在同一个可聚焦元素上是刻意的——用一个只读图标
 * 表示状态、再在旁边放一个小按钮，等于让用户去猜哪个能点。
 *
 * **这一排只有图标，没有名字**（`tray-ui.md` §3，2026-10-23 定）：44×44 的方块里只有
 * 标识，一行最多 7 个，放不下就折行、不横滚。名字挪到**悬停与键盘聚焦**时出现的 tooltip。
 * 两只手都要照顾到，所以 tooltip 是自定义元素（`styles.css` 里 `:hover` 与
 * `:focus-visible` 各一条），不是原生 `title`：后者延迟约 1 秒，样式在深浅色下也不受控，
 * 而名字是这个面板上唯一的文字，不该有延迟，也不该有的用户看得到、有的看不到。
 *
 * **少了看得见的文字，就得在别处补回来（硬要求）**：每个 tile 都带
 * `aria-label="名字 · 状态"`，否则读屏拿到的是一个**无名按钮**。
 *
 * 状态**先靠形状**分：在跑的 = 强调描边 + 右下角**实心**点，没跑的 = 中性描边 + **空心**圈。
 * 文字没了之后，形状要是也一样，状态就只剩颜色一个通道——那正是设计体系禁止的。
 * 颜色是第二通道，tooltip 与 `aria-label` 是第三通道。
 */
export function AgentStatusRow(props: AgentStatusRowProps) {
  return (
    <div className="abx-agents" role="group" aria-label="agent 状态">
      {props.agents.map((agent) => {
        const running = props.runningIds.includes(agent.id)
        const state: AgentTileState = running ? 'running' : 'idle'
        const text = tileText(agent, state)
        return (
          <button
            key={agent.id}
            type="button"
            className="abx-agent"
            data-state={state}
            // 状态也走 `aria-pressed`，不靠颜色/实心：色觉差异与读屏用户同样要能判断。
            aria-pressed={running}
            aria-label={text}
            // 品牌色走自定义属性，样式表里拿它给方块打底；没给颜色时变量缺席，退回中性色。
            style={
              agent.icon?.color === undefined
                ? undefined
                : ({ '--abx-agent-color': agent.icon.color } as CSSProperties)
            }
            onClick={() => {
              if (!running) props.onStart(agent.id)
            }}
          >
            <span
              className="abx-agent-mark"
              // 有图标时带上标识（给图形资产和样式一个锚点），没有就整个属性都不出现。
              data-icon={agent.icon?.slug}
              aria-hidden="true"
            >
              {/* 字母是没有图形资产时的回退；图形本身是界面层的事。 */}
              {agent.label.slice(0, 1)}
            </span>
            <span className="abx-agent-dot" aria-hidden="true" />
            {/* tooltip 与 `aria-label` 是同一句话：改一处，两处一起变。
                `aria-hidden` 是因为读屏已经通过 `aria-label` 拿到了它，不隐藏会被念两遍。 */}
            <span className="abx-agent-tip" aria-hidden="true">
              {text}
            </span>
          </button>
        )
      })}
    </div>
  )
}
