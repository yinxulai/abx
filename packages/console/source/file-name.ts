/**
 * 从绝对路径里取最后一段。
 *
 * 面板上显示**名字**、完整路径放 `title`：卡片只有 366 宽，一行塞不下整条路径，
 * 而用户认的是名字。两种分隔符都认——路径是宿主给的，渲染层不该假设是哪一种。
 */
export function fileName(filePath: string): string {
  // 去掉末尾的分隔符，否则 `/Users/alain/notes/` 会取到空串。
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] ?? trimmed
}
