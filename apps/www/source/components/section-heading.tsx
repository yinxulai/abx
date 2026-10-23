type SectionHeadingProps = {
  eyebrow: string
  id: string
  lead?: string
  title: string
}

/** 每一节的统一开头：小标签 + 标题 + 一句导语。标题 id 供 `aria-labelledby` 使用。 */
export const SectionHeading = ({ eyebrow, id, lead, title }: SectionHeadingProps) => (
  <div className="max-w-2xl">
    <p className="text-xs tracking-[0.16em] text-ice uppercase">{eyebrow}</p>
    <h2
      className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
      id={id}
    >
      {title}
    </h2>
    {lead === undefined ? null : (
      <p className="mt-4 text-base leading-relaxed text-ink-2">{lead}</p>
    )}
  </div>
)
