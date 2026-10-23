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
  /**
   * 镜像引用，例如 `abx-agent-claude:2.1.308`。不可用时要说清是哪个镜像没构建，
   * 所以这一栏不只是给人看的，也是那句话说完整的一半。
   */
  readonly image: string
  /**
   * 镜像构建了没有。**没有**时这个 agent 是「不可用」，不是「未运行」——
   * 前者的下一步是去构建镜像，后者是点一下。两者长得一样就等于把原因藏起来了。
   */
  readonly imageBuilt: boolean
}

export interface AgentStatusRowProps {
  readonly agents: readonly PanelAgent[]
  /** 正在跑的 agent id。 */
  readonly runningIds: readonly string[]
  readonly onStart: (agentId: string) => void
}

/**
 * 一个方块的三种状态。**状态表来自 `apps/docs/specs/product/design-system.md` §9**，
 * 与它一一对应；样式在 `styles.css` 里按 `data-state` 各写一段（三段的差别是
 * 线的样式、填充、标记形状和文字，不只是颜色）。
 *
 * 用联合类型而不是几个布尔：布尔能表达出「没构建**并且**在跑」这种没有意义的状态，
 * 联合类型不能。
 */
type AgentTileState = 'running' | 'idle' | 'unavailable'

/** 状态怎么**说**：用动作词，不用形容词（文档 §8：「未运行」写「启动」）。 */
const STATE_LINE: Readonly<Record<AgentTileState, string>> = {
  running: '运行中 · 聚焦',
  idle: '启动',
  unavailable: '镜像未构建',
}

const STATE_LABEL: Readonly<Record<AgentTileState, string>> = {
  running: '运行中，点击聚焦',
  idle: '未运行，点击启动',
  unavailable: '不可用，先构建镜像',
}

function tileState(agent: PanelAgent, running: boolean): AgentTileState {
  if (!agent.imageBuilt) return 'unavailable'
  return running ? 'running' : 'idle'
}

/**
 * 一排 agent 方块，**既是状态指示也是启动按钮**。
 *
 * 两者不分开：点它是起一个新舱，名字下面那行字直接把这个动作写出来。面板里没有菜单、
 * 没有二级页，所以「状态」和「动作」落在同一个可聚焦元素上是刻意的——用一个只读图标
 * 表示状态、再在旁边放一个小按钮，等于让用户去猜哪个能点。
 *
 * **名字不随状态变淡**。「运行中」靠加强表达（更粗的实心边、实心方块、实心点），
 * 不靠削弱「未运行」；唯一的例外是镜像还没构建的那个——它真的不能点，所以它既被压暗，
 * 也说清原因和下一步（文档 §5、§8）。
 */
export function AgentStatusRow(props: AgentStatusRowProps) {
  return (
    <div className="abx-agents" role="group" aria-label="agent 状态">
      {props.agents.map((agent) => {
        const running = props.runningIds.includes(agent.id)
        const state = tileState(agent, running)
        const unavailable = state === 'unavailable'
        return (
          <button
            key={agent.id}
            type="button"
            className="abx-agent"
            data-state={state}
            // 状态走 `aria-pressed` 而不是靠颜色/实心：色觉差异与读屏用户同样要能判断。
            aria-pressed={running}
            aria-label={`${agent.label}：${STATE_LABEL[state]}`}
            // 不可用那一个不给点：它的下一步是构建镜像，不是起舱。
            disabled={unavailable}
            title={unavailable ? `${agent.image} 还没构建 · 先构建镜像` : agent.label}
            onClick={() => {
              if (state === 'idle') props.onStart(agent.id)
            }}
          >
            <span
              className="abx-agent-square"
              // 有图标时带上标识（给图形资产和样式一个锚点），没有就整个属性都不出现。
              data-icon={agent.icon?.slug}
              // 品牌色走自定义属性，样式表里拿它调底色；没给颜色时变量缺席，退回中性色。
              style={
                agent.icon?.color === undefined
                  ? undefined
                  : ({ '--abx-agent-color': agent.icon.color } as CSSProperties)
              }
              aria-hidden="true"
            >
              {/* 两行结构不变：上一行是图标方块，下面依次是名字与状态。字母仍是最稳的回退。 */}
              {agent.label.slice(0, 1)}
            </span>
            <span className="abx-agent-name">{agent.label}</span>
            <span className="abx-agent-state">
              {unavailable ? (
                <span className="abx-agent-warn" aria-hidden="true">
                  ⚠
                </span>
              ) : (
                <span className="abx-agent-dot" aria-hidden="true" />
              )}
              {STATE_LINE[state]}
            </span>
            {unavailable && <span className="abx-agent-next">先构建镜像</span>}
          </button>
        )
      })}
    </div>
  )
}
