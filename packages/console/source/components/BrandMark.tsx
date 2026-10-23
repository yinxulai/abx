export interface BrandMarkProps {
  /** 尺寸与对齐由使用处给（标题栏那处是 `.abx-mark`）。 */
  readonly className?: string
}

/**
 * 品牌标志：一个 Bot 的头。头就是舱体，**两只挖空的眼睛**是那个受控的进出口。
 *
 * 这**不是**一份新的画稿：几何逐字来自唯一矢量源 `packages/console/public/icon.svg`
 * ——所有的位图（托盘、打包图标、站点 favicon）都由 `pnpm icons` 从那个文件派生。
 * 这里之所以内联而不是 `<img src="icon.svg">`，是因为标志要与旁边的文字一起排版
 * （同一个 flex 行、跟着主题走），而 `<img>` 会多一次加载、在面板从 `file://` 打开时
 * 还要多管一条相对路径。
 *
 * **代价是这里出现了第二份几何**，所以 `BrandMark.test.tsx` 拿渲染出来的这一份与真源
 * 逐条对账：`viewBox`、三段渐变的 stop、矩形的框、蒙版里那两只眼睛。形状一改，
 * 真源与这里必须同时改，否则测试红——**两份相似的东西比一份缺失的更糟**。
 *
 * 它是**装饰**：产品名由旁边的文字 `abx` 承载（`design-system.md` §5 的骨架一），
 * 所以固定 `aria-hidden`。标志的颜色属于品牌（黄→橙→粉的渐变），
 * 与界面的点缀色 `--accent` 是两个东西（同文档 §2）。
 */
export function BrandMark(props: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      focusable="false"
      // 1:1 取自真源的 `viewBox`，不换算：一切几何都以它为单位。
      viewBox="0 0 256 256"
    >
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="abx-mark"
          x1="41"
          x2="215"
          y1="16"
          y2="241"
        >
          {/* osw 那道闪电的前三段，**故意没有第四段紫**（`assets/brand/README.md`）。 */}
          <stop offset="0" stopColor="#FFE066" />
          <stop offset="0.42" stopColor="#FF9500" />
          <stop offset="1" stopColor="#F0297C" />
        </linearGradient>
        {/* 眼睛是**洞**：蒙版挖掉两只圆，透出来的是底色，不是画上去的白点。
            所以单色档、纯白托盘蒙版里它们照样成立。 */}
        <mask id="abx-eyes">
          <rect fill="#fff" height="256" width="256" />
          <circle cx="85" cy="128" fill="#000" r="24" />
          <circle cx="171" cy="128" fill="#000" r="24" />
        </mask>
      </defs>
      {/* 头本身只有这一笔：一个圆角矩形，挖掉眼睛。 */}
      <rect fill="url(#abx-mark)" height="188" mask="url(#abx-eyes)" rx="62" width="224" x="16" y="34" />
    </svg>
  )
}
