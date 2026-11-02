// 行块前缀（缩进 + 逐级引用标记 + 列表标记 + 任务框）的树驱动抽取。
//
// 旧列表续写用一条正则 `^(\s*)((?:> )*)([-*+]|\d+[.)])...`，只能识别“先引用后
// 列表”的顺序，于是 `> text` 完全没有续写（Enter 掉出引用）、`- > text` 丢掉 `> `，
// 而引用 toggle 用 `startsWith("> ")` 判断，认不出 `>x` / `  > x` / `- > x`。
// 这里统一从 Lezer 树取段，语法知识留在解析层，`format/quotes.ts`（Enter 续写）与
// `format/commands.ts`（引用 toggle）共用同一份判定。
import type { EditorState, Line } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { syntaxTree } from "@codemirror/language"

const MARK_NAMES = new Set(["QuoteMark", "ListMark", "TaskMarker"])

type MarkKind = "quote" | "list" | "task"

export interface BlockPrefixMark {
  readonly kind: MarkKind
  /** 标记原文 + 其后紧跟的空格/制表符（区间连续，拼起来即整行前缀）。 */
  readonly text: string
  readonly from: number
  /** 标记原文的绝对终点（不含其后的空白）。 */
  readonly markTo: number
  /** 段终点：标记 + 其后全部空白（续写前缀按段拼接，保持用户原有间距）。 */
  readonly to: number
}

export interface BlockPrefix {
  /** 首个标记之前的缩进（`  > x` 的两个空格；引用嵌套在列表里时为空）。 */
  readonly indent: string
  /** 行首到内容起点的原文（含每一级标记后的空格）。 */
  readonly text: string
  readonly marks: readonly BlockPrefixMark[]
  /** 最内层标记之后的内容是否为空（整行只有块前缀）。 */
  readonly blank: boolean
}

/**
 * 视觉列：CommonMark 的制表位是每 4 列一个停靠点，`\t` 前进到下一个停靠点。
 * 行块前缀是纯 ASCII 结构段（缩进 + 标记 + 空白），其余字符按一列算。
 */
export function visualColumn(text: string): number {
  let column = 0
  for (const ch of text) column += ch === "\t" ? 4 - (column % 4) : 1
  return column
}

/**
 * 列表标记的**逻辑内容列**（CommonMark）：marker 语法之后只有 1–4 视觉列的空白算内容
 * 缩进；0 列或 5+ 列时退化成一列，剩下的空白属于内容（`-     parent` 的正文其实是
 * 缩进代码块）。`BlockPrefixMark.to` 含标记后**全部**空白，直接拿它当内容列会让嵌套
 * 宽度变成 marker 后的整段空白 —— Tab/续写插六格，新条目重解析成 `CodeBlock`。
 * 不是列表标记（或标记原文不合列表语法）时返回 null，不猜层级。
 */
export function listContentColumn(line: Line, mark: BlockPrefixMark): number | null {
  if (mark.kind !== "list") return null
  const marker = line.text.slice(mark.from - line.from, mark.markTo - line.from)
  if (!/^(?:[-+*]|\d+[.)])$/.test(marker)) return null
  const markerEnd = visualColumn(line.text.slice(0, mark.markTo - line.from))
  const padding = visualColumn(line.text.slice(0, mark.to - line.from)) - markerEnd
  return markerEnd + (padding >= 1 && padding <= 4 ? padding : 1)
}

/**
 * 抽取当前行的块前缀（缩进 + 逐级引用标记 + 列表标记 + 任务框）。
 * 只认“从行首起、由标记与空白构成”的连续前缀：标记前出现正文即停止。
 * 语法树尚未覆盖该行时返回 null（调用方放行默认 Enter，不猜结构）。
 */
export function blockPrefixOf(state: EditorState, line: Line): BlockPrefix | null {
  const marks: { kind: MarkKind; from: number; to: number }[] = []
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.from < line.from || node.to > line.to) return
      if (!MARK_NAMES.has(node.name)) return
      marks.push({
        kind: node.name === "QuoteMark" ? "quote" : node.name === "ListMark" ? "list" : "task",
        from: node.from,
        to: node.to,
      })
    },
  })
  if (marks.length === 0) return null
  marks.sort((a, b) => a.from - b.from)

  const segments: BlockPrefixMark[] = []
  let cursor = line.from
  for (const mark of marks) {
    if (mark.from < cursor) continue
    const gap = line.text.slice(cursor - line.from, mark.from - line.from)
    if (!/^[ \t]*$/.test(gap)) break
    let end = mark.to
    while (end < line.to) {
      const ch = line.text[end - line.from]
      if (ch !== " " && ch !== "\t") break
      end++
    }
    segments.push({ kind: mark.kind, text: line.text.slice(mark.from - line.from, end - line.from), from: mark.from, markTo: mark.to, to: end })
    cursor = end
  }
  if (segments.length === 0) return null
  return {
    indent: line.text.slice(0, segments[0].from - line.from),
    text: line.text.slice(0, cursor - line.from),
    marks: segments,
    blank: line.text.slice(cursor - line.from).trim() === "",
  }
}

/**
 * 删除某个标记的最小区间：标记本身 + 其后一个空格/制表符。
 * 多余的空白属于内容缩进（`  >   x` 去掉引用应为 `    x`），不能被一并吞掉。
 */
export function markRemovalRange(mark: BlockPrefixMark, line: Line): { from: number; to: number } {
  const after = line.text[mark.markTo - line.from]
  const extra = after === " " || after === "\t" ? 1 : 0
  return { from: mark.from, to: mark.markTo + extra }
}

/**
 * 续写前缀：先补回首个标记前的缩进，再逐段原样复制；只有两处按“新条目”语义
 * 改写 —— 有序列表 marker 递增（与 listKeymap 的 nextMarker 一致），任务框重置
 * 为未勾选。
 *
 * `keep` 只复制前 n 段：空列表项“退出一层/退出列表”就是同一规则套在**父条目**
 * （或当前行）截断后的前缀上 —— 退出一层保留父条目的列表标记并递增，退出列表
 * 则把它之前的引用前缀原样留下。
 */
export function continuePrefixText(prefix: BlockPrefix, keep: number = prefix.marks.length): string {
  return prefix.indent + prefix.marks.slice(0, keep).map(mark => {
    if (mark.kind === "list") return nextListMark(mark.text)
    if (mark.kind === "task") return "[ ] "
    return mark.text
  }).join("")
}

/** CommonMark 有序 marker 只允许 1–9 位数字（`1000000000.` 不是 marker）。 */
const ORDERED_MARKER_MAX = 999_999_999

/** 新条目的列表标记：有序 marker 递增（保留 `)` 分隔符），其余原样复制。 */
function nextListMark(text: string): string {
  const ordered = /^(\d+)([.)])[ \t]*$/.exec(text)
  if (!ordered) return text
  // 越过上限的 marker 会重解析成段落：上限处**重复**合法 marker 而不回绕到 1（回绕像列表重新开始）。
  const next = Math.min(Number(ordered[1]) + 1, ORDERED_MARKER_MAX)
  return `${next}${ordered[2]} `
}

/**
 * 非空列表条目的续写前缀（同一物理行上的祖先层级只留缩进）。
 *
 * 行前缀里当前条目标记之前的每个 ListMark 都属于一个**祖先** ListItem：`- - child` 的
 * 外层 `-`、`1. 1. child` 的外层 `1.` 都是父层结构，续写时要变成等宽空格（父层自己的
 * marker 内容列），否则新行重生整条标记链 —— 内层 list 的兄弟变成“新外层条目里再嵌
 * 一层”（`- - child` → `- - `）。只有当前 ListItem 自己的 marker 递增（有序）或原样
 * 重复（无序），它自己的 TaskMarker 重置为未勾选；**祖先**的任务框不占缩进宽度
 * （`- [ ] parent` 下的子条目续写仍是两空格，不是六格）。引用标记不是层级，原样保留。
 *
 * 宽度一律是**视觉列**（制表位每 4 列）：`-\t- child` 的祖先内容列是 4，不是
 * `mark.text.length` 的 2 —— 补两空格会让新行重解析成外层兄弟。
 *
 * 祖先链从 Lezer 取，并逐位核对行前缀里的列表标记：对不上就返回 null（不猜层级）。
 */
export function listContinuationPrefix(state: EditorState, frame: ListFrame): string | null {
  const { prefix, markIndex, item } = frame
  const lineNumber = state.doc.lineAt(prefix.marks[markIndex].from).number
  const ancestors: number[] = []
  for (let node = ancestorListItem(item); node; node = ancestorListItem(node)) {
    const mark = node.getChild("ListMark")
    if (!mark) return null
    // 只有与当前条目**同一行**的祖先标记出现在行前缀里，其余靠行首已有的空白缩进。
    if (state.doc.lineAt(mark.from).number === lineNumber) ancestors.unshift(mark.from)
  }
  const leading = prefix.marks.slice(0, markIndex).filter(mark => mark.kind === "list")
  if (leading.length !== ancestors.length) return null
  if (leading.some((mark, i) => mark.from !== ancestors[i])) return null

  let text = prefix.indent
  for (let index = 0; index < prefix.marks.length; index++) {
    const mark = prefix.marks[index]
    if (index === markIndex) text += nextListMark(mark.text)
    else if (index > markIndex) text += mark.kind === "task" ? "[ ] " : mark.text
    // 当前标记之前的引用是结构，照抄；祖先列表标记换成缩进，推到它的视觉内容列。
    else if (mark.kind === "quote") text += mark.text
    else if (mark.kind === "list") {
      const column = listContentColumn(state.doc.lineAt(mark.from), mark)
      const padding = column === null ? -1 : column - visualColumn(text)
      if (padding < 0) return null
      text += " ".repeat(padding)
    }
    else return null
  }
  return text
}

/**
 * 行内容起点：行块前缀（缩进 + 每个标记 + 恰好一个后随空白）之后的位置；无标记的行
 * 返回 `line.from`（行首缩进属于内容，例如代码块里的缩进）。
 *
 * 前缀是**块结构**而不是可键入文本：光标停在前缀内部会让折叠标记展开（`cursorInside`），
 * 随后输入的字插在标记左边 —— 用户看到的是 `>` 被推着往右跑。所有把光标送进行的入口
 * （点击 / Home / ↑↓ / 续行命令）都应经过这里，见 `navigation/caretClamp.ts`。
 */
export function lineContentStart(state: EditorState, line: Line): number {
  const prefix = blockPrefixOf(state, line)
  if (!prefix || prefix.marks.length === 0) return line.from
  return markRemovalRange(prefix.marks[prefix.marks.length - 1], line).to
}

/** `pos` 落在行块前缀内部时钳到内容起点，否则原样返回。 */
export function clampToContentStart(state: EditorState, pos: number): number {
  const start = lineContentStart(state, state.doc.lineAt(pos))
  return pos < start ? start : pos
}

/** 前缀里最内层列表标记的下标（任务框不是列表标记）。 */
export function innermostListMark(prefix: BlockPrefix): number {
  for (let i = prefix.marks.length - 1; i >= 0; i--) if (prefix.marks[i].kind === "list") return i
  return -1
}

/**
 * Enter 归属：最内层**非任务**块标记。任务框挂在它前面的列表上，自己不当 owner ——
 * `> - [x] x` 归列表语义（任务框只是条目内容的一部分），`- > x` 归引用。
 * 只有任务框（或没有标记）时返回 null。
 */
export function enterOwnerMark(prefix: BlockPrefix): BlockPrefixMark | null {
  for (let i = prefix.marks.length - 1; i >= 0; i--) {
    if (prefix.marks[i].kind !== "task") return prefix.marks[i]
  }
  return null
}

export interface ListFrame {
  readonly prefix: BlockPrefix
  /** 当前行最内层列表标记所属的 `ListItem`。 */
  readonly item: SyntaxNode
  /** `item` 自己的 ListMark 在 `prefix.marks` 里的下标。 */
  readonly markIndex: number
  /** 嵌套时的父 `ListItem`；顶层条目为 null。 */
  readonly parentItem: SyntaxNode | null
}

/**
 * 列表行结构里 Tab/Enter 共用的一半：当前行块前缀 + 最内层 `ListItem` + 父条目。
 * 行前缀不含列表标记、或树未覆盖该标记时返回 null —— 不猜层级。
 */
export function listFrameAt(state: EditorState, line: Line): ListFrame | null {
  const prefix = blockPrefixOf(state, line)
  if (!prefix) return null
  const markIndex = innermostListMark(prefix)
  if (markIndex < 0) return null
  const item = innermostListItem(state, prefix.marks[markIndex].from)
  if (!item) return null
  return { prefix, item, markIndex, parentItem: ancestorListItem(item) }
}

export interface ItemMark {
  /** 条目自己那一行（标记行）。 */
  readonly line: Line
  readonly prefix: BlockPrefix
  /** 条目自己的 ListMark 在 `prefix.marks` 里的下标。 */
  readonly index: number
}

/**
 * `item` 自己那一行的块前缀 + 自己 ListMark 的下标。
 * 同一物理行上的嵌套（`- - `）使父行前缀含多个列表标记，此处的权威是
 * `item` 的直接子 ListMark 位置 —— 取整行最内层标记会拿到子层。
 */
export function itemMarkAt(state: EditorState, item: SyntaxNode): ItemMark | null {
  const mark = item.getChild("ListMark")
  if (!mark) return null
  const line = state.doc.lineAt(item.from)
  const prefix = blockPrefixOf(state, line)
  if (!prefix) return null
  const index = prefix.marks.findIndex(segment => segment.kind === "list" && segment.from === mark.from)
  return index < 0 ? null : { line, prefix, index }
}

function innermostListItem(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "ListItem") return node
  }
  return null
}

function ancestorListItem(item: SyntaxNode): SyntaxNode | null {
  for (let node: SyntaxNode | null = item.parent; node; node = node.parent) {
    if (node.name === "ListItem") return node
  }
  return null
}
