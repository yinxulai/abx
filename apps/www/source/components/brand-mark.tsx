type BrandMarkProps = { className?: string }

/**
 * 品牌标志：一个 Bot 的头。头就是舱体，两只挖空的眼睛是那个受控的进出口。
 *
 * 几何逐字来自唯一矢量源 `packages/console/public/icon.svg`。这里之所以内联一份、
 * 而不是 `<img>`：站点自己在 `<head>` 里发的那份 `public/icon.svg` 是**产物**
 * （Vite 不允许从 `public/` 里 import），而标志在页头要与文字同一行排版、跟着主题走。
 * 代价是这里出现了第二份几何，所以 `brand-mark.test.tsx` 拿渲染出来的这一份与
 * `apps/www/public/icon.svg` 逐条对账——**两份相似的东西比一份缺失的更糟**。
 *
 * 纯装饰：名字由旁边的文字 `abx` 承担（`design-system.md` §5、§2）。
 * 颜色是**品牌色**（黄→橙→粉的渐变），与站点那处冷色点缀是两个东西。
 */
export const BrandMark = ({ className }: BrandMarkProps) => (
  <svg
    aria-hidden="true"
    className={className}
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
      {/* 眼睛是**洞**：蒙版挖掉两只圆，透出来的是底色，不是画上去的白点。 */}
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
