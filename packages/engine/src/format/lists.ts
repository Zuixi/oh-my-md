import { Prec, type EditorState, type Line, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command, type EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import {
  continuePrefixText,
  innermostListMark,
  itemMarkAt,
  listContentColumn,
  listContinuationPrefix,
  listFrameAt,
  visualColumn,
  type BlockPrefix,
  type ListFrame,
} from "./blockPrefix"

// 列表续写/缩进的行结构全部来自 Lezer 树（blockPrefix.ts::listFrameAt）：行块前缀 +
// ListItem 祖辈。旧的 `LINE` 正则只能逐字符猜，既看不到嵌套层级（空条目该怎么退层），
// 也把 `> - `、`1)`、多位数 marker 的判定建在固定宽度假设上。

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    // readOnly 是建议性 facet：keymap 命令直接 dispatch 会绕过输入拦截
    // （typed input 才被 view 层挡下），只读 Live 预览档必须在此拒绝改写。
    // 返回 false 与 @codemirror/commands 的 readOnly 约定一致，放行后续键位。
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

/** 单光标守卫：多个 range（哪怕都是空光标）时不知道该改哪一端，整体放行后续键位。 */
function singleCursor(state: EditorState): boolean {
  const { ranges, main } = state.selection
  return ranges.length === 1 && main.empty
}

/** 同上的结构帧（最内层 ListItem + 父条目），Tab/Enter 共用。 */
function listFrameLineAt(state: EditorState): (ListFrame & { line: Line }) | null {
  if (!singleCursor(state)) return null
  const line = state.doc.lineAt(state.selection.main.head)
  const frame = listFrameAt(state, line)
  return frame ? { ...frame, line } : null
}

/** 当前列表容器里的前一项；若当前是首项，再尝试紧邻的另一种列表容器末项。 */
function lastDirectListItem(list: SyntaxNode): SyntaxNode | null {
  for (let node = list.lastChild; node; node = node.prevSibling) {
    if (node.name === "ListItem") return node
  }
  return null
}

function previousSiblingItem(state: EditorState, item: SyntaxNode): SyntaxNode | null {
  for (let node = item.prevSibling; node; node = node.prevSibling) {
    if (node.name === "ListItem") return node
  }
  // 不同 marker 类型会被 Lezer 拆成相邻列表容器（`1. parent\n- child`）。当前条目是
  // 新容器的首项，但编辑体验里上一容器的末项仍是它可缩进到的直接前项。只跨越紧邻
  // 的 OrderedList/BulletList，且物理行必须连续；空行或其它块会切断这种关系。
  const list = item.parent
  const previousList = list?.prevSibling
  if (previousList?.name !== "OrderedList" && previousList?.name !== "BulletList") return null
  const previous = lastDirectListItem(previousList)
  if (!previous) return null
  const previousPos = previous.to > previous.from ? previous.to - 1 : previous.from
  const previousEndLine = state.doc.lineAt(previousPos).number
  const currentStartLine = state.doc.lineAt(item.from).number
  return currentStartLine === previousEndLine + 1 ? previous : null
}

function endsWithOrderedChildList(item: SyntaxNode): boolean {
  return item.lastChild?.name === "OrderedList"
}

function nestedOrderedMarker(state: EditorState, mark: BlockPrefix["marks"][number], sibling: SyntaxNode): string | null {
  const text = state.sliceDoc(mark.from, mark.markTo)
  const match = /^(\d+)([.)])$/.exec(text)
  if (!match || endsWithOrderedChildList(sibling)) return null
  return `1${match[2]}`
}

function indentListCommand(target: EditorView): boolean {
  if (target.state.readOnly) return false
  // `indentListSpec` 对“当前是列表，但没有可缩进的前项”按纯函数约定返回 null。
  // 命令层仍必须消费 Tab，否则浏览器会把焦点移出编辑器。
  if (!listFrameLineAt(target.state)) return false
  const result = indentListSpec(target.state)
  if (result) target.dispatch(result)
  return true
}

/**
 * 嵌套空条目退出一层：复制**父条目那一行**的块前缀，截到**父条目自己的**列表标记
 * （含紧随其后的任务框）后按新条目改写 —— 有序列表用父层级的下一个序号
 * （`1. parent` 下的空子项 → `2. `），任务框重置为未勾选，引用/缩进原样保留。
 * 同一行嵌套（`- - `）时截断点是父 ListItem 自己的 ListMark，不是整行的最内层标记。
 */
function stepOutText(parentPrefix: BlockPrefix, parentMarkIndex: number): string {
  const task = parentPrefix.marks[parentMarkIndex + 1]?.kind === "task" ? 1 : 0
  return continuePrefixText(parentPrefix, parentMarkIndex + 1 + task)
}

/**
 * Enter 续写。非空条目在当前层继续（有序 marker 递增、任务框重置、同一行上的祖先层级
 * 只留缩进）；空前条目退出列表：顶层的只保留外层引用前缀（`> - ` → `> `），嵌套的退出
 * 一层（`  - ` 在 `- parent` 下 → `- `）。非空选区交还默认 Enter（替换选区是破坏性操作，
 * 不该被续写劫持）。
 */
export function continueListSpec(state: EditorState): TransactionSpec | null {
  const found = listFrameLineAt(state)
  if (!found) return null
  const { line, prefix, parentItem } = found
  if (!prefix.blank) {
    const continuation = listContinuationPrefix(state, found)
    if (!continuation) return null
    // 光标落在前缀内部（Home/鼠标点在标记与内容之间）时按内容起点切分，与 continueQuote 一致。
    const head = Math.max(state.selection.main.head, line.from + prefix.text.length)
    const insert = `\n${continuation}`
    return { changes: { from: head, to: head, insert }, selection: { anchor: head + insert.length } }
  }
  // 退出时的截断点必须是**父条目自己**那一行的标记（同一行嵌套时父行前缀含多个列表标记）。
  const parent = parentItem ? itemMarkAt(state, parentItem) : null
  if (parentItem && !parent) return null
  const insert = parent
    ? stepOutText(parent.prefix, parent.index)
    : continuePrefixText(prefix, innermostListMark(prefix))
  return { changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } }
}

/**
 * 空的顶层列表项按 Backspace 直接退出列表。lang-markdown 的默认命令会把 `2. `
 * 改成等宽空格，随后输入 `-` 就悄悄变成前一项的嵌套列表；这里仅接管无父 ListItem、
 * 光标位于空前缀末尾的精确场景。嵌套项和显式进入 marker 内部的编辑仍交还上游。
 */
export function deleteEmptyTopLevelListSpec(state: EditorState): TransactionSpec | null {
  const found = listFrameLineAt(state)
  if (!found || found.parentItem || !found.prefix.blank) return null
  if (state.selection.main.head !== found.line.to) return null
  const insert = continuePrefixText(found.prefix, innermostListMark(found.prefix))
  return {
    changes: { from: found.line.from, to: found.line.to, insert },
    selection: { anchor: found.line.from + insert.length },
    userEvent: "delete.backward",
  }
}

export function indentListSpec(state: EditorState): TransactionSpec | null {
  const found = listFrameLineAt(state)
  if (!found) return null
  const sibling = previousSiblingItem(state, found.item)
  if (!sibling) return null
  const siblingMark = itemMarkAt(state, sibling)
  if (!siblingMark) return null
  // 嵌套列的权威是上一个同级条目**内容**的列：ListMark + 其逻辑 padding（CommonMark
  // 只有 1–4 视觉列算数，0/5+ 退化成一列），不含 TaskMarker（`- [ ] x` 的嵌套宽度是 2，
  // 不是 6）。列按视觉列算（制表位每 4 列），`-\t` 是 4。
  const targetColumn = listContentColumn(siblingMark.line, siblingMark.prefix.marks[siblingMark.index])
  if (targetColumn === null) return null
  const mark = found.prefix.marks[found.markIndex]
  const column = columnOf(found.line, mark.from)
  if (targetColumn <= column) return null
  // 缩进插在**自己 ListMark 之前**（空格一列一颗，插满即到目标列），引用前缀留在行首。
  const indent = " ".repeat(targetColumn - column)
  const orderedMarker = nestedOrderedMarker(state, mark, sibling)
  return orderedMarker
    ? { changes: { from: mark.from, to: mark.markTo, insert: indent + orderedMarker } }
    : { changes: { from: mark.from, to: mark.from, insert: indent } }
}

/** `pos` 在 `line` 里的视觉列（行首 = 0）。 */
function columnOf(line: Line, pos: number): number {
  return visualColumn(line.text.slice(0, pos - line.from))
}

export function outdentListSpec(state: EditorState): TransactionSpec | null {
  const found = listFrameLineAt(state)
  if (!found || !found.parentItem) return null
  const parent = itemMarkAt(state, found.parentItem)
  if (!parent) return null
  const parentMark = parent.prefix.marks[parent.index]
  const mark = found.prefix.marks[found.markIndex]
  // 同一物理行上的嵌套（`- - x` / `> - - [x] x`）：父标记与当前标记之间没有对齐空白，
  // 中间那段**就是**父层本身。整段删掉 = 去掉父列表层（连同嵌在该层里的任务框/引用段），
  // 父标记之前的前缀与当前标记之后的任务框/内容都原样保留。
  if (parent.line.number === found.line.number) {
    return parentMark.from < mark.from
      ? { changes: { from: parentMark.from, to: mark.from, insert: "" } }
      : null
  }
  // 跨行时把当前标记对齐到**父标记的视觉列**：可重写的只有 Lezer 划定的那段空白缩进
  // —— 上一段标记的原文终点到当前标记之间（含上一段标记自己的后随空白，那正是
  // `>   - x` 里的对齐空格）。列是**视觉列**：制表符不是一列，不能拿源码偏移相减。
  // 那段含正文、或需要右移（不是外移）时拒绝改写。
  const gapFrom = found.markIndex > 0 ? found.prefix.marks[found.markIndex - 1].markTo : found.line.from
  const gap = state.sliceDoc(gapFrom, mark.from)
  if (!/^[ \t]*$/.test(gap)) return null
  const needed = columnOf(parent.line, parentMark.from) - columnOf(found.line, gapFrom)
  if (needed < 0 || needed >= visualColumn(gap)) return null
  return { changes: { from: gapFrom, to: mark.from, insert: " ".repeat(needed) } }
}

export const continueList = dispatchSpec(continueListSpec)
export const deleteEmptyTopLevelList = dispatchSpec(deleteEmptyTopLevelListSpec)
export const indentList = indentListCommand
export const outdentList = dispatchSpec(outdentListSpec)

// Prec.highest：@codemirror/lang-markdown 的 markdown() 自带 Prec.high 的 Enter
// 键位（insertNewlineContinueMarkup），且 markdownLanguageSupport() 排在 editorExtensions
// 第一位 —— 同优先级先注册者胜，停在 Prec.high 会让上游抢走列表 Enter（空条目退层、
// 多位序号、引用/任务样式全部由上游决定）。
export const listKeymap = Prec.highest(keymap.of([
  { key: "Enter", run: continueList },
  { key: "Backspace", run: deleteEmptyTopLevelList },
  { key: "Tab", run: indentList },
  { key: "Shift-Tab", run: outdentList },
]))
