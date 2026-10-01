import type { Line } from "@codemirror/state"
import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { keymap, type Command } from "@codemirror/view"
import { lineContentStart } from "./blockPrefix"

// 围栏代码**内容行**的续行与缩进。
//
// 为什么单独一层：引用内的代码内容行带行块前缀（`> `），而 @codemirror/lang-markdown
// 的 insertNewlineContinueMarkup 在 FencedCode 内主动 bail（getContext 遇到
// FencedCode 直接 return），于是这些行落到别的命令手里 —— 结果要么只补前缀、丢掉
// 代码缩进（新行与上一行不对齐），要么把光标留在上一行（插入点正好在光标处时
// CodeMirror 的默认映射不移动光标）。本模块只认「围栏内容行」这一种行，其余行返回
// null 让 continueFence / continueQuote / continueList / 宿主命令各自接管。
//
// 判定必须严格，否则会抢走开围栏行（continueFence 要补全闭合围栏）与闭围栏行
// （编辑态由 line:omd-codeblock-num 折叠）：光标行含 CodeMark 一律让位。

const INDENT_UNIT = "  "
// 光标前的内容以开括号/冒号结尾 → 新行再缩进一级（IDE 手感的最小启发式）。
// 完整的语言感知缩进应走 indentService，但 markdown 只声明 Document: () => null，
// 嵌套语言在 IndentContext 里也拿不到节点属性（实测 getIndentation 在围栏内恒为
// null，见 docs/memory/gotchas-engine.md「围栏内没有缩进服务」）。
const OPENS_BLOCK = /[{([:]$/

export interface CodeContentLine {
  readonly line: Line
  /** 行块前缀原文（引用/列表标记 + 后随空白）；无前缀时为空串。 */
  readonly prefix: string
  /** 去掉前缀后的代码内容。 */
  readonly content: string
}

/** 从行尾向前一字符解析：行首可能落在 QuoteMark 上（同 fences.ts 的注释）。 */
function fencedCodeAt(state: EditorState, line: Line) {
  let node = syntaxTree(state).resolveInner(Math.max(line.from, line.to - 1), 1)
  while (node && node.name !== "FencedCode") {
    if (!node.parent) return null
    node = node.parent
  }
  return node
}

export function codeContentLine(state: EditorState): CodeContentLine | null {
  const main = state.selection.main
  if (!main.empty) return null
  const line = state.doc.lineAt(main.head)
  const fence = fencedCodeAt(state, line)
  if (!fence) return null
  for (let child = fence.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark" && state.doc.lineAt(child.from).number === line.number) return null
  }
  // 前缀边界 = 标记 + 恰好一个后随空白；其余空白属于**代码缩进**而不是前缀，
  // 否则 Tab/Shift-Tab 改不到缩进（会被前缀吞掉），"与上一行对齐"也只是碰巧。
  const end = lineContentStart(state, line)
  return { line, prefix: state.doc.sliceString(line.from, end), content: state.doc.sliceString(end, line.to) }
}

/** 新行内容缩进：默认复制当前行的前导空白（与上一行对齐），开括号结尾再进一级。 */
function nextIndent(content: string, caretInContent: number): string {
  const base = /^[ \t]*/.exec(content)?.[0] ?? ""
  if (OPENS_BLOCK.test(content.slice(0, caretInContent).trimEnd())) return `${base}${INDENT_UNIT}`
  return base
}

function contentStartOf(info: CodeContentLine): number {
  return info.line.from + info.prefix.length
}

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    // readOnly 是建议性 facet：keymap 命令直接 dispatch 会绕过输入拦截。
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

/**
 * 代码内容行回车：插入换行 + 行块前缀 + 内容缩进，并把光标显式放到新行内容起点。
 * 光标落在前缀内部时按内容起点切分（与前缀内回车不得复制标记后空格同理）。
 */
export function continueCodeLineSpec(state: EditorState): TransactionSpec | null {
  const info = codeContentLine(state)
  if (!info) return null
  const contentStart = contentStartOf(info)
  const at = Math.max(state.selection.main.head, contentStart)
  const caretInContent = Math.min(info.content.length, Math.max(0, at - contentStart))
  const insert = `\n${info.prefix}${nextIndent(info.content, caretInContent)}`
  return { changes: { from: at, to: at, insert }, selection: { anchor: at + insert.length } }
}

/** Tab：在内容起点插入一级缩进（整行缩进，与 IDE 的“缩进当前行”一致）。 */
export function indentCodeLineSpec(state: EditorState): TransactionSpec | null {
  const info = codeContentLine(state)
  if (!info) return null
  const at = contentStartOf(info)
  return {
    changes: { from: at, to: at, insert: INDENT_UNIT },
    selection: { anchor: state.selection.main.head + INDENT_UNIT.length },
  }
}

/** Shift-Tab：去掉内容起点的一级缩进（最多两个空白字符）。 */
export function outdentCodeLineSpec(state: EditorState): TransactionSpec | null {
  const info = codeContentLine(state)
  if (!info) return null
  const remove = /^[ \t]{1,2}/.exec(info.content)?.[0]
  if (!remove) return null
  const at = contentStartOf(info)
  const head = state.selection.main.head
  return {
    changes: { from: at, to: at + remove.length, insert: "" },
    selection: { anchor: Math.max(at, head - remove.length) },
  }
}

export const continueCodeLine = dispatchSpec(continueCodeLineSpec)
export const indentCodeLine = dispatchSpec(indentCodeLineSpec)
export const outdentCodeLine = dispatchSpec(outdentCodeLineSpec)

// Prec.highest：@codemirror/lang-markdown 的 markdown() 自带 Prec.high 的 Enter
// 键位（insertNewlineContinueMarkup），同优先级先注册者胜 —— 引擎的 Enter 家族必须
// 提到 highest，否则归属由上游决定（见 editorExtensions 注释与 known-gotchas）。
export const codeLineKeymap = Prec.highest(keymap.of([
  { key: "Enter", run: continueCodeLine },
]))

export const codeIndentKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: indentCodeLine },
  { key: "Shift-Tab", run: outdentCodeLine },
]))
