import type { SharedEntryRejection } from '@abx/contracts'
import { fileName } from '../file-name'

export interface SharedRejectionListProps {
  readonly rejected: readonly SharedEntryRejection[]
}

/**
 * 面板上只显示理由的**第一句**：那句说的是「因为什么被拒」，例如
 * 「目录里有凭据文件：notes/.env 命中 *.env（共 1 个）。」。
 *
 * 后面的句子讲的是「这条规则为什么长这样」（整体挂载、减不掉、静默少挂更危险），
 * 那是给写代码的人与日志看的，放进 `title`。卡片只有 366 宽，整段铺开会把共享区
 * 挤出可视区，而用户最需要的是「哪个东西、为什么没进来」。
 */
export function firstSentence(reason: string): string {
  const end = reason.indexOf('。')
  return end === -1 ? reason : reason.slice(0, end + 1)
}

/**
 * 没进共享区的条目。
 *
 * **不进上面的列表**——列在那里就等于说「它共享上了」；也不能悄悄消失，
 * 所以在这儿把原因写出来。不是 toast、不是弹窗：用户回头再看列表时，
 * 那句话还得在原处等他，而不是三秒后自己没了。
 */
export function SharedRejectionList(props: SharedRejectionListProps) {
  if (props.rejected.length === 0) return null

  return (
    <div className="abx-rejected">
      {/* 「失败 / 被拒」那一行要求危险色 + 图标 + 具体原因（设计体系 §5）：
          图标不是装饰，它让这行在色觉差异下也读得出是「出错了」而不是「只是灰了一点」。 */}
      <p className="abx-rejected-head">
        <span className="abx-rejected-icon" aria-hidden="true">
          ⚠
        </span>
        {props.rejected.length} 项未加入共享区
      </p>
      <ul className="abx-rejected-list" aria-label="未加入共享区的条目">
        {props.rejected.map((item) => (
          <li className="abx-rejected-row" key={item.path}>
            <span className="abx-rejected-name" title={item.path}>
              {fileName(item.path)}
            </span>
            <span className="abx-rejected-reason" title={item.reason}>
              {firstSentence(item.reason)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
