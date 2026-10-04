import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { blockPrefixOf, continuePrefixText } from "./blockPrefix"
import { isUnclosedFenceLine } from "./fences"

// 引用块（以及任意引用/列表组合）的 Enter 续写。
//
// Prec.highest：@codemirror/lang-markdown 的 markdown() 自带 Prec.high 的 Enter
// 键位（insertNewlineContinueMarkup），同优先级先注册者胜 —— 引擎的 Enter 家族必须
// 提到 highest，否则归属由上游决定（`> ` 空前缀行会留下孤零零的 `>` 而不是退出一层）。
// 纯列表行没有 QuoteMark → 本命令返回 null，继续由 continueList / 上游处理；围栏行
// 同理让位 continueFence。

/**
 * Enter 续写引用/引用+列表行。空内容行退出一层（去掉最内层标记，保留外层）：
 * `> ` → 空行、`> > ` → `> `、`- ` → 空行、`> - ` → `> `。
 * 非空内容行在光标处插入换行 + 完整前缀（`> a` → `> a\n> `）。
 * 非空选区交还默认 Enter（替换选区是破坏性操作，不该被续写劫持）。
 */
export function continueQuoteSpec(state: EditorState): TransactionSpec | null {
  const main = state.selection.main
  if (!main.empty) return null
  const line = state.doc.lineAt(main.head)
  // 未闭合围栏行让位给 continueFence（它按引用前缀补全闭合围栏并把光标放到内容行）：
  // 两个命令因此互斥，键位注册顺序不影响结果。
  if (isUnclosedFenceLine(state)) return null
  const prefix = blockPrefixOf(state, line)
  // 只有带引用标记的行归本命令：纯列表/围栏行保持各自既有命令的语义。
  if (!prefix || !prefix.marks.some(mark => mark.kind === "quote")) return null
  if (prefix.blank) {
    const outer = prefix.marks.length > 1 ? prefix.marks[prefix.marks.length - 2].to : line.from
    const insert = state.doc.sliceString(line.from, outer)
    // 显式 selection：插入/删除都必须把光标放到「剩余前缀之后」，不能依赖 CodeMirror
    // 对插入点处折叠光标 assoc=-1 的默认映射（那会把光标留在上一行）。
    return { changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } }
  }
  // 光标落在前缀内部（`> |文本`，例如 Home/鼠标点在标记与内容之间）时按内容起点切分：
  // 否则原行的标记后空格会被留在新行内容前，续写后多出一个空格。
  const head = Math.max(main.head, line.from + prefix.text.length)
  const insert = `\n${continuePrefixText(prefix)}`
  return { changes: { from: head, to: head, insert }, selection: { anchor: head + insert.length } }
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

export const continueQuote = dispatchSpec(continueQuoteSpec)

// 与 listKeymap/fenceKeymap 同级但排在它们之前（editorExtensions 顺序）：
// 引用行优先由本命令续写，其余行返回 false 放行后续键位。
export const quoteKeymap = Prec.highest(keymap.of([
  { key: "Enter", run: continueQuote },
]))
