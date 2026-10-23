type AirlockMarkProps = { className?: string }

/**
 * 品牌标记：一扇带中缝的舱门。纯装饰，所以对辅助技术隐藏。
 * `currentColor` 让它在深色页头、页脚里各自取色，不用维护两份图形。
 */
export const AirlockMark = ({ className }: AirlockMarkProps) => (
  <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 28 28">
    <rect
      height="25"
      rx="7"
      stroke="currentColor"
      strokeOpacity="0.28"
      width="25"
      x="1.5"
      y="1.5"
    />
    <circle cx="14" cy="14" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M14 7.5v13"
      stroke="currentColor"
      strokeOpacity="0.5"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
)
