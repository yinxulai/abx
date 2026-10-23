/**
 * 传递窗（transom）：舱内做出来的东西递给宿主的那道口子。
 *
 * 名字还是那套隐喻：气闸有两道门，外面那道小门就是**传递窗**——船上的东西从这里
 * 递出去，但气压不会跟着走。今天舱内 agent 做出来的报告、图、PDF 全部烂在容器里：
 * 舱内没有显示器，人不在舱里，唯一的通道是一个没人看的 TTY。这个模块定义的是
 * 「什么东西可以递、递出去之后谁来打开」的**判据**。
 *
 * ## 这个文件为什么住在 contracts
 *
 * 它只描述形状与判据，不碰文件系统、不起进程、不读凭据——所以舱内那侧（shim）
 * 与宿主那侧（broker）可以引用同一份定义。**两侧必须用同一份**：判定分散在两处时，
 * 「宿主说这是 txt、shim 说这是可执行文件」这种分歧迟早会出现，而它恰好发生在
 * 唯一一条能把东西送出舱的路径上。
 *
 * ## 一条不能让步的红线
 *
 * **「打开」不是「执行」。** 如果对任意文件都调默认应用，那么舱里递出来一个
 * `.app` / `.sh` / `.command` 就等于**在宿主上执行了舱内的代码**——舱里的东西
 * 通过一个文件逃出了舱，而这正是 abx 存在的理由。所以：
 *
 *   - 能不能打开**只看白名单**（`AUTO_OPEN_EXTENSIONS`），不在名单里的一律
 *     只「在文件夹中显示」，绝不用默认应用打开。未知即拒绝，不是「未知即放行」；
 *   - 名单外的那一份 `NEVER_AUTO_OPEN_EXTENSIONS` **不参与判定**，它只是把
 *     「哪些东西特别危险」写下来给人和测试看。以黑名单为判据的话，明天新出现的
 *     一种可执行后缀会自动获得放行。
 */

/**
 * 传递窗 MCP 服务在舱内叫什么。
 *
 * 它会出现在 agent 的配置文件里（`mcpServers` 的键），也会出现在 MCP 握手时
 * 自报的 `serverInfo.name`。两处必须是同一个值——否则 agent 面板上显示的名字
 * 与它实际连上的东西对不上。
 */
export const TRANSOM_SERVER_NAME = 'abx'

/**
 * 宿主舱面上 MCP 端点的路径。
 *
 * 挂在**舱面**（要舱令牌的那个监听面）而不是宿主面：宿主面不校验身份，
 * 而传递窗能做「把文件写到宿主的目录里」这件事，它必须知道是谁在请求。
 */
export const TRANSOM_ENDPOINT_PATH = '/mcp'

/** 传递窗暴露的工具。**只有这两个**，`http_fetch` / `run_shell` 这类东西永远不加。 */
export const TRANSOM_TOOL_NAMES: readonly string[] = ['publish', 'open']

/**
 * shim 的文件名。
 *
 * 它同时是宿主上的文件名与挂载源的最后一段——挂载策略会核对这个字面量，
 * 所以它只能有一个来源（就是这里）。
 */
export const MCP_SHIM_FILE_NAME = 'abx-mcp-shim.mjs'

/**
 * shim 在舱内的固定落点。
 *
 * **固定**是有意的：agent 的配置模板是**数据**（见 `agents.ts` 的 `configFiles`），
 * 数据里写不出「这次会话算出来的那个路径」。落点固定，模板才能是一份静态文本。
 *
 * 选 `/usr/local/lib/abx/` 而不是 `<cellHome>` 下面：舱内 home 里挂的东西要么是
 * agent 自己的历史（那是个可写目录），要么是它的配置文件；abx 自己的运行时文件
 * 混进去，既会被持久化进实例目录，也会让「这个目录里的东西都是 agent 的」这句话
 * 不再成立。实测（`node:22-slim` + `--read-only`）：docker 会为绑定挂载补出中间目录，
 * 所以这个路径在镜像里不存在也没关系。
 */
export const MCP_SHIM_CELL_PATH = '/usr/local/lib/abx/abx-mcp-shim.mjs'

/**
 * 单次交付的体积上限：64 MiB。
 *
 * 依据有两条，一条产品、一条工程：
 *
 *   1. **传递窗是「递给人看一眼」的地方，不是搬东西的通道。** 一份报告、一张图、
 *      一个 PDF、一份导出表，都在几十 MB 以内。真正大的数据（数据集、模型、
 *      构建产物）本来就有更好的路：任务目录在宿主上就是可见的，需要共享进来的
 *      东西走共享区，两边都是绑定挂载，一个字节都不用复制。
 *   2. **每一次 publish 都是一次宿主侧的完整复制**，而且是舱内进程能反复触发的。
 *      没有上限的话，一个跑飞的 agent 能在几分钟里把宿主磁盘写满——这是一条
 *      「舱内能影响宿主」的路径，而这条路径本来不该存在。
 *
 * **为什么不静默截断**：截断出来的是一个**坏文件**——PDF 打不开、图只显示一半、
 * CSV 少了后半截的表。用户看到的是「agent 做出来的东西是坏的」，而不是「它太大了」，
 * 前者会让人怀疑整套东西，后者他立刻知道该怎么做（把大文件放进任务目录）。
 * 所以宁可直接拒绝，并把实际大小与上限一起报出来。
 */
export const MAX_DELIVERABLE_BYTES = 64 * 1024 * 1024

/** 1 MiB，把字节数说成人话时用。 */
const MIB = 1024 * 1024

/**
 * **能自动打开**的后缀白名单。
 *
 * 判定**只**看这张表，大小写不敏感，带不带点都认。表里这几种东西的共同点是
 * 「交给默认应用打开」不会执行任何东西：图片、PDF、纯文本、以及几种纯数据文本。
 *
 * 反过来说，**加一条进来等于放松一道闸**：`svg` 能跑脚本、`html` 能跑脚本、
 * `docx` / `xlsx` 会让办公套件去解析一个压缩包结构。加之前先想清楚它是不是
 * 「看一眼」的东西。
 */
export const AUTO_OPEN_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'log',
]

/**
 * **永不自动打开**的后缀。
 *
 * ⚠️ **这张表不参与判定。** 判定是白名单：不在 `AUTO_OPEN_EXTENSIONS` 里的一律
 * 只显示不打开，用不着它点头。它存在的意义是文档与测试：
 * `classifyDeliverable()` 会在报错理由里点名说清「这是可执行/安装包」，而测试会
 * 逐条断言这些后缀的处置**都不是** `open`。
 *
 * 以黑名单为判据是这类闸门最经典的错法：明天出现一种新的可执行后缀（`.desktop`
 * 当年就是这么来的），它不在表里，于是**自动获得放行**。
 */
export const NEVER_AUTO_OPEN_EXTENSIONS: readonly string[] = [
  'app',
  'sh',
  'command',
  'scpt',
  'dmg',
  'pkg',
  'exe',
  'bat',
  'desktop',
]

/**
 * 能做进「abx 自己的预览」的那些后缀。**今天一个都没有被打开过。**
 *
 * `html` / `svg` 能跑脚本。用系统浏览器打开一个 `file://` 页面，等于让舱内写出来的
 * 东西在宿主上执行：那种页面能读本地文件、能往外发请求，而这一切都发生在**舱外**。
 * 所以它们**绝不**走「默认应用」那条路。
 *
 * 正确的形态是 abx 自己渲染一个不给 `allow-scripts` 的 sandbox iframe（不联网）。
 * 那一块属于面板（`packages/console`）——本轮不做，所以这两个后缀现在与
 * 「未知后缀」同处置：**只在文件夹中显示**。用户仍然拿得到文件，只是不会被
 * 宿主替它执行。等预览落地时，改的是这一张表与 `classifyDeliverable()` 的一处分支。
 */
export const INLINE_PREVIEW_EXTENSIONS: readonly string[] = ['html', 'htm', 'svg']

/** 一条交付物的处置。只有两种，没有「打开但降级成别的」这种中间态。 */
export type DeliverableDisposition =
  /** 交给系统的默认应用打开。只可能是白名单里的那几种。 */
  | 'open'
  /** 只在文件夹中显示（高亮那一个文件），**不执行任何东西**。 */
  | 'reveal'

export interface DeliverableClassification {
  /** 判定用的文件名（已取最后一段）。 */
  readonly fileName: string
  /** 小写、不带点的后缀；空串表示没有后缀。 */
  readonly extension: string
  readonly disposition: DeliverableDisposition
  /** 说清为什么是这个处置。它会进审计，也是报错时给人看的那句话。 */
  readonly reason: string
}

/**
 * 这个文件名该怎么处置。
 *
 * 纯函数，两侧共用（宿主用它决定怎么打开，shim 用它解释结果）。
 * **判定顺序**是「白名单 → 其余一律 reveal」，每一步的理由都不一样，
 * 因为「为什么没打开」是用户唯一能拿到的线索。
 */
export function classifyDeliverable(fileName: string): DeliverableClassification {
  const base = lastSegment(fileName)
  const extension = extensionOf(base)

  if (AUTO_OPEN_EXTENSIONS.includes(extension)) {
    return {
      fileName: base,
      extension,
      disposition: 'open',
      reason: `后缀 .${extension} 在自动打开的白名单里，交给系统的默认应用。`,
    }
  }

  if (INLINE_PREVIEW_EXTENSIONS.includes(extension)) {
    return {
      fileName: base,
      extension,
      disposition: 'reveal',
      reason:
        `.${extension} 能跑脚本：用系统浏览器打开一个 file:// 页面，等于让舱内写出来的东西在宿主上执行` +
        `（它能读本地文件、能往外发请求，而且都发生在舱外）。abx 自己的预览（不给 allow-scripts 的 sandbox iframe）` +
        `还没做，所以现在只在文件夹中显示，不打开。`,
    }
  }

  if (extension === '') {
    return {
      fileName: base,
      extension,
      disposition: 'reveal',
      reason:
        '这个文件没有后缀：可能是二进制、可能是脚本，判不出来。判定以白名单为准，判不出来就不打开，只在文件夹中显示。',
    }
  }

  if (NEVER_AUTO_OPEN_EXTENSIONS.includes(extension)) {
    return {
      fileName: base,
      extension,
      disposition: 'reveal',
      reason:
        `.${extension} 是可执行文件或安装包：用默认应用打开它就是在**宿主上执行舱内的代码**。` +
        `只在文件夹中显示——东西还在，要不要跑由你决定。`,
    }
  }

  return {
    fileName: base,
    extension,
    disposition: 'reveal',
    reason:
      `后缀 .${extension} 不在自动打开的白名单里。白名单之外的**一律**不打开` +
      `（不是「未知即放行」）：只在文件夹中显示。`,
  }
}

/** 把字节数说成人话。报错与审计里都用它，免得两处各写一套换算。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / MIB).toFixed(1)} MiB`
}

/**
 * 取路径的最后一段。
 *
 * 两种分隔符都切：文件名可能来自一个 windows 风格的路径（配置、日志、跨平台脚本），
 * 而 `path.basename` 在 posix 上不认反斜杠。要的只是「名字」，与来源平台无关。
 */
function lastSegment(fileName: string): string {
  const segments = fileName.split(/[/\\]/)
  return segments[segments.length - 1] ?? ''
}

/**
 * 后缀，小写、不带点。
 *
 * **前导点不算后缀**：`.bashrc` 没有后缀（它是隐藏文件，不是「后缀为 bashrc 的文件」），
 * 而 `.env` 同理——这一点很重要，把 `.env` 判成「后缀 env」再放进白名单，
 * 就是一次把凭据文件当文本打开的事故。
 */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return ''
  return fileName.slice(dot + 1).toLowerCase()
}
