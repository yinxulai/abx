/**
 * 共享条目：用户从宿主上拖进来、要**共享给全部 agent** 的那样东西。
 *
 * 这里只放**形状**：一条条目是什么、一批条目在界面上是什么样。真正决定「能不能挂、
 * 挂到舱内哪儿」的是 `@abx/core` 的 `resolveSharedMounts()`——那个要读文件系统，
 * 不该出现在这个包里，更不该出现在面板的产物里。
 *
 * 两条约定值得先读，它们是这个形状存在的理由：
 *
 *   1. **`kind` 由宿主 stat 得出，不由 UI 传、也不由调用方声明。** 面板里那个
 *      「是文件还是目录」的图标来自宿主算出来的值；拖放那一刻浏览器给的判断
 *      （`webkitGetAsEntry`）只能当**即时预览**，因为它看不见软链、也挡不住
 *      调用方自己编一个 kind 递进来。
 *   2. **路径必须是绝对路径，且不许出现 `..`。** 相对路径的含义取决于谁在哪儿跑，
 *      而 `..` 能把一个人畜无害的路径变成 `/home`——挂载策略那一侧的闸门是从
 *      一个绝对、已解析的路径开始判的，这里先把形状卡死，那边才有东西可判。
 */

import { z } from 'zod'

/** 共享条目的两类。**没有第三种**：可写共享是后续作业，不在这里预留字段。 */
export const SHARED_ENTRY_KINDS = ['file', 'directory'] as const

export type SharedEntryKind = (typeof SHARED_ENTRY_KINDS)[number]

/**
 * 绝对路径判定不用 `node:path`。
 *
 * 这个模块会被面板（浏览器产物）打包，而 `node:path` 在那边是个空对象——
 * `path.isAbsolute` 到运行时才变成 undefined。所以这里按**形状**判，用的是纯正则。
 *
 * 三种形状都认，因为这条路径来自宿主，而宿主可能是 Windows：
 *   - `/home/dev/notes` —— POSIX；
 *   - `C:\Users\dev\notes`、`C:/Users/dev/notes` —— Windows 的盘符绝对路径；
 *   - `\\server\share\notes` —— UNC。
 *
 * **原先只认 `startsWith('/')`**，于是 Windows 上拖进来的每一条条目都在这里被拒，
 * 表现是「拖了没反应」——存进 `shared.json` 又读不出来，中间没有任何一句话。
 * 判定放在这一层而不是按平台分支：这个 schema 判的是「形状像不像一条宿主绝对路径」，
 * 而它拿不到平台（浏览器产物里也没有）。真正的分平台闸门在
 * `@abx/core` 的 `resolveSharedMounts()`，那里有平台。
 */
const POSIX_ABSOLUTE = /^\//
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_ABSOLUTE = /^[\\/]{2}[^\\/]/

function isAbsolutePath(value: string): boolean {
  return POSIX_ABSOLUTE.test(value) || WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC_ABSOLUTE.test(value)
}

/**
 * 路径里有没有 `..` 这一整段。`..foo` 是合法的文件名，不算。
 *
 * 两种分隔符都切：Windows 的路径里可能有 `/`（`C:/Users/../Windows`），
 * POSIX 的文件名里可以有 `\`（`notes\..\x` 是一个普通文件名，不是上跳两级）。
 * 这里取的是**宽**的那一边——多切一种分隔符只会多拒掉几个可疑写法，
 * 而漏切一种就是一个能绕过闸门的写法。真正的判定同样在 `resolveSharedMounts()`。
 */
function hasParentSegment(value: string): boolean {
  return value.split(/[/\\]/).includes('..')
}

export const sharedEntrySchema = z.object({
  path: z
    .string()
    .min(1, '共享条目的路径不能为空')
    .refine(isAbsolutePath, '共享条目必须是绝对路径')
    .refine((value) => !hasParentSegment(value), '共享条目的路径里不允许出现 ..'),
  kind: z.enum(SHARED_ENTRY_KINDS),
})

/**
 * 一条共享条目。
 *
 * `path` 是**用户拖进来的那个路径**（宿主上的绝对路径），不是解析软链之后的结果。
 * 解析结果属于挂载那一层，不进这个形状——否则界面上显示的就不是用户认识的那个名字了。
 */
export interface SharedEntry {
  readonly path: string
  readonly kind: SharedEntryKind
}

/** 宿主上那条路径现在还在不在。 */
export interface SharedEntryState extends SharedEntry {
  /**
   * 条目失效：宿主上的文件/目录已经被删了。
   *
   * 失效条目标出来但**不移除**：共享列表是用户自己攒的，abx 替他删掉等于
   * 悄悄改他的东西；而挂载那一刻如果还失效，就是一次「以为共享了、其实没有」。
   */
  readonly missing: boolean
}

/**
 * 一条**没进共享区**的条目，以及为什么。
 *
 * 存在的理由是「一条坏条目不该让整个会话起不来」：被拒的条目返回给调用方，
 * 由它决定怎么呈现（面板在共享区下面给一行原因）。只有在这一批条目**全被拒**、
 * 而调用方又要求「至少挂一个」的时候，才升级成异常。
 */
export interface SharedEntryRejection {
  /** 被拒的那条条目的原始路径（不是解析后的），这样用户对得上自己拖的那个东西。 */
  readonly path: string
  /** 为什么。这句话要能被用户照着改，不能只说「禁止」。 */
  readonly reason: string
}

/**
 * 面板拿到的快照：宿主已经 stat 过、解析过的那一份。
 *
 * `entries` 是进了共享区的（含失效的），`rejected` 是没进的。两者都来自宿主，
 * 面板一个字节都不自己判断。
 */
export interface SharedListSnapshot {
  readonly entries: readonly SharedEntryState[]
  readonly rejected: readonly SharedEntryRejection[]
}

export type ParseSharedEntryResult =
  | { readonly ok: true; readonly entry: SharedEntry }
  | { readonly ok: false; readonly reason: string }

/**
 * 校验一条来路不明的数据是不是合法的共享条目。
 *
 * 用得着它的地方是**读持久化文件**：那份 JSON 在用户的磁盘上，可以被手改、
 * 也可能是上一个版本写的。一条坏记录只该被丢掉，不该让面板整个打不开，
 * 而丢掉的时候要给得出理由（所以这里返回 union 而不是抛）。
 */
export function parseSharedEntry(input: unknown): ParseSharedEntryResult {
  const parsed = sharedEntrySchema.safeParse(input)
  if (parsed.success) return { ok: true, entry: parsed.data }
  const [issue] = parsed.error.issues
  return { ok: false, reason: issue?.message ?? '不是合法的共享条目' }
}
