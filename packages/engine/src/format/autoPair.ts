import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import {
  CharCategory,
  Compartment,
  EditorSelection,
  Prec,
  StateEffect,
  type EditorState,
  type Extension,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"

// 引擎自研的 Markdown 感知自动配对（spec 2026-10-02-auto-pair-design）。stock
// `closeBrackets` 三处 AGENTS 明文禁止：它的 token 表与上下文模型都是「猜编程语言字符串」，
// 而 omd 要的是「括号/引号全上下文保留、Markdown 标记仅在正文生效」。
//
// 三个 spec 函数是纯函数：只**返回** TransactionSpec | null，绝不 dispatch、不碰
// EditorView（§4.5 纯函数契约）。唯一 dispatcher 是 autoPairExtension 里的适配层 ——
// 「任一 range 不满足即整体放弃」因此物理上不可能产生局部改写（D10）。

export interface AutoPairOptions {
  /** `(` `[` `{` — 全部上下文（含代码块/行内代码/数学/前导元数据）。 */
  readonly brackets: boolean
  /** `"` 与 `'`（`'` 另有前一字符门控）。 */
  readonly quotes: boolean
  /** `*` `_` `` ` `` `$` — 仅正文（§4.4）。 */
  readonly markdownSyntax: boolean
}

export const DEFAULT_AUTO_PAIR: AutoPairOptions = {
  brackets: true,
  quotes: true,
  markdownSyntax: true,
}

/** D8：CM6 的 `)]}:;>` 加上 CJK 句读与闭符号。有意的超集，必须具名维护。 */
export const CLOSE_BEFORE = ")]}:;>，。、；：！？）】》”’"

/** D11：行首只有这两个有块结构风险（`*` 变列表项、`$` 进 MathBlock）。 */
export const EMPTY_LINE_MARKERS = new Set(["*", "$"])

/** §4.4：这些节点内 Markdown 标记按字面处理（T1 括号/引号不受影响）。 */
export const VERBATIM_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "InlineMath",
  "MathBlock",
  "FrontMatter",
])

export const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
export const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'" }
export const MARKER_PAIRS: Record<string, string> = { "*": "*", "_": "_", "`": "`", "$": "$" }

/**
 * §4.4 抑制集：true = 代码/数学/前导元数据**或树未就绪**（D9）。
 * `syntaxTreeAvailable` 是 O(1) 且不触发解析，只在标记分支被调用（T1 逐键零树查询）。
 */
export function inVerbatim(state: EditorState, pos: number): boolean {
  // D9 fail-safe：上下文不可知时抑制而不是放行 —— 误配对会在代码块里插入用户没要的字符。
  if (!syntaxTreeAvailable(state, pos + 1)) return true
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (VERBATIM_NODES.has(node.name)) return true
  }
  return false
}

/**
 * 当前上下文里真正生效的闭合符（D12：verbatim 下不含 T2 标记）。
 * 成对删除一律传 verbatim = false —— 成对删除刻意不过滤上下文（规则 4）。
 */
function activeClosers(options: AutoPairOptions, verbatim: boolean): Set<string> {
  const closers = new Set<string>()
  if (options.brackets) for (const close of Object.values(BRACKET_PAIRS)) closers.add(close)
  if (options.quotes) for (const close of Object.values(QUOTE_PAIRS)) closers.add(close)
  if (options.markdownSyntax && !verbatim) {
    for (const marker of Object.values(MARKER_PAIRS)) closers.add(marker)
  }
  return closers
}

/** 括号：`BRACKET_PAIRS[prev] === next`；引号与标记：`prev === next`；均需对应开关开启。 */
function isMatchingOpen(prev: string, next: string, options: AutoPairOptions): boolean {
  if (options.brackets && BRACKET_PAIRS[prev] === next) return true
  if (options.quotes && QUOTE_PAIRS[prev] === next) return true
  return options.markdownSyntax && MARKER_PAIRS[prev] === next
}

/** 规则 1 的逐 range 门控；任一 range 为 false 即整体放弃（D10）。 */
function rangeAccepts(
  state: EditorState,
  range: SelectionRange,
  text: string,
  isMarker: boolean,
  options: AutoPairOptions,
): boolean {
  if (!range.empty) return false  // v1 不做选区包裹（D7 / Task 4）
  const prev = range.from > 0 ? state.doc.sliceString(range.from - 1, range.from) : ""
  if (prev === "\\") return false
  if (text === "'" && /[A-Za-z0-9]/.test(prev)) return false
  const next = state.doc.sliceString(range.to, range.to + 1)
  if (next && !/\s/.test(next) && !CLOSE_BEFORE.includes(next)) return false
  if (isMarker) {
    if (prev === text) return false  // 2a：手打 `**bold**` 能走通的唯一条件
    if (EMPTY_LINE_MARKERS.has(text)) {  // 2b（D11，只对 `*` 与 `$`）
      const line = state.doc.lineAt(range.from)
      if (line.text.slice(0, range.from - line.from).trim() === "") return false
    }
    if (inVerbatim(state, range.from)) return false  // §4.4
  }
  return true
}

/** 规则 1 — 插入：返回 spec 或 null；不适用时交给 CM 默认管线（裸字符给所有光标）。 */
export function autoPairSpec(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  options: AutoPairOptions,
): TransactionSpec | null {
  if (state.readOnly || text.length !== 1) return null
  // DOM diff 只对应聚焦（主）range —— CM6 自身也这么比（§4.5）。
  const main = state.selection.main
  if (main.from !== from || main.to !== to) return null
  const isMarker = !!MARKER_PAIRS[text]
  const enabled = isMarker
    ? options.markdownSyntax
    : (options.brackets && !!BRACKET_PAIRS[text]) || (options.quotes && !!QUOTE_PAIRS[text])
  if (!enabled) return null
  const close = BRACKET_PAIRS[text] ?? text
  let bailed = false
  const spec = state.changeByRange(range => {
    if (!rangeAccepts(state, range, text, isMarker, options)) {
      bailed = true
      return { range }
    }
    return {
      changes: { from: range.from, to: range.to, insert: text + close },
      range: EditorSelection.cursor(range.from + 1),
    }
  })
  if (bailed) return null  // 交回默认插入：所有光标都拿到裸字符（D10）
  return { changes: spec.changes, selection: spec.selection, userEvent: "input.type" }
}

/**
 * 规则 3 — 无状态跳越：后接字符与输入相同，且其后一个不是词字符（CM6 charCategorizer）。
 * 必须先于插入判定，否则 `*bold*` 的收尾会变成 `*bold**`。
 */
export function autoPairTypeOverSpec(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  options: AutoPairOptions,
): TransactionSpec | null {
  if (state.readOnly || text.length !== 1) return null
  const main = state.selection.main
  if (main.from !== from || main.to !== to) return null
  if (!activeClosers(options, false).has(text)) return null
  const isMarker = !!MARKER_PAIRS[text]
  let bailed = false
  const spec = state.changeByRange(range => {
    if (!range.empty) {
      bailed = true
      return { range }
    }
    // D12：verbatim 里的标记不是配对符 —— 插入路径把它当普通字符，跳越也不许吞掉它。
    const verbatim = isMarker && inVerbatim(state, range.from)
    if (!activeClosers(options, verbatim).has(text)) {
      bailed = true
      return { range }
    }
    if (state.doc.sliceString(range.to, range.to + 1) !== text) {
      bailed = true
      return { range }
    }
    const after = state.doc.sliceString(range.to + 1, range.to + 2)
    if (after && state.charCategorizer(range.to + 1)(after) === CharCategory.Word) {
      bailed = true
      return { range }
    }
    return { range: EditorSelection.cursor(range.from + 1) }
  })
  if (bailed) return null
  return { selection: spec.selection, userEvent: "input.type" }
}

/**
 * 规则 4 — 成对删除（Backspace）。刻意不做 `inVerbatim` 过滤（D12 的例外，对齐 CM6
 * deleteBracketPair）：删除是用户主动按键，多删一个符合代码编辑器预期，一次 Undo 可回退。
 */
export function deletePairSpec(state: EditorState, options: AutoPairOptions): TransactionSpec | null {
  if (state.readOnly) return null
  let bailed = false
  const spec = state.changeByRange(range => {
    if (!range.empty) {
      bailed = true
      return { range }
    }
    const prev = range.from > 0 ? state.doc.sliceString(range.from - 1, range.from) : ""
    const next = state.doc.sliceString(range.to, range.to + 1)
    if (!isMatchingOpen(prev, next, options)) {
      bailed = true
      return { range }
    }
    return {
      changes: { from: range.from - 1, to: range.to + 1, insert: "" },
      range: EditorSelection.cursor(range.from - 1),
    }
  })
  if (bailed) return null
  return { changes: spec.changes, selection: spec.selection, userEvent: "delete.backward" }
}

/** 三开关的热切换槽；装配点见 `packages/engine/src/index.ts`（不经 barrel 导出）。 */
export const autoPairCompartment = new Compartment()

/** 输入层适配：inputHandler（跳越优先于插入）+ Prec.high Backspace。 */
export function autoPairExtension(options: AutoPairOptions): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing || view.compositionStarted || view.state.readOnly) return false
      const spec = autoPairTypeOverSpec(view.state, from, to, text, options)
        ?? autoPairSpec(view.state, from, to, text, options)
      if (!spec) return false
      view.dispatch(spec)
      return true
    }),
    // Prec.high：desktop 的 defaultKeymap 在 editorExtensions() 之前注册，
    // 同优先级先注册者胜；不适用时必须 return false，让 skipAtomic / deleteCharBackward 接手。
    Prec.high(keymap.of([{
      key: "Backspace",
      run: target => {
        const spec = deletePairSpec(target.state, options)
        if (!spec) return false
        target.dispatch(spec)
        return true
      },
    }])),
  ]
}

/** 热切换三个开关（desktop 设置面板经 `@omd/engine` 导出的 setAutoPair 调用）。 */
export function setAutoPair(options: AutoPairOptions): StateEffect<unknown> {
  return autoPairCompartment.reconfigure(autoPairExtension(options))
}
