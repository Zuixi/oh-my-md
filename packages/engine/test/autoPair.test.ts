import { history, undo } from "@codemirror/commands"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { makeState } from "./helpers"
import { markdownLanguageSupport } from "../src/parse/markdown"
import {
  autoPairSpec,
  autoPairTypeOverSpec,
  deletePairSpec,
  inVerbatim,
  BRACKET_PAIRS,
  CLOSE_BEFORE,
  EMPTY_LINE_MARKERS,
  MARKER_PAIRS,
  QUOTE_PAIRS,
  VERBATIM_NODES,
  type AutoPairOptions,
} from "../src/format/autoPair"

// 纯 spec 矩阵（spec §4.2–§4.5 / 验收 §6）：三个 spec 函数只返回 TransactionSpec | null，
// 这里逐个判定它们，不经过 EditorView。assert 的期望值全部来自 spec 的表格。

const ALL: AutoPairOptions = { brackets: true, quotes: true, markdownSyntax: true }
const NONE: AutoPairOptions = { brackets: false, quotes: false, markdownSyntax: false }
const NO_QUOTES: AutoPairOptions = { brackets: true, quotes: false, markdownSyntax: true }
const NO_BRACKETS: AutoPairOptions = { brackets: false, quotes: true, markdownSyntax: true }
const NO_MARKERS: AutoPairOptions = { brackets: true, quotes: true, markdownSyntax: false }

/** Detached state with a collapsed cursor — enough for the T1/bracket paths (no tree query). */
function cursorState(doc: string, pos: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: pos } })
}

/** Same, but with a complete syntax tree — required by every marker case (§4.4). */
function markerState(doc: string, pos: number): EditorState {
  return makeState(doc).update({ selection: { anchor: pos } }).state
}

/**
 * Two cursors in a state that keeps them: CM6 collapses a multi-range selection to
 * `asSingle()` unless the host enables `allowMultipleSelections` (D10 tests need it).
 */
function multiCursorState(doc: string, ...heads: number[]): EditorState {
  return makeState(doc, [EditorState.allowMultipleSelections.of(true)]).update({
    selection: EditorSelection.create(heads.map(h => EditorSelection.cursor(h)), heads.length - 1),
  }).state
}

function insertSpecOf(state: EditorState, text: string, options: AutoPairOptions = ALL): TransactionSpec | null {
  const main = state.selection.main
  return autoPairSpec(state, main.from, main.to, text, options)
}

function typeOverSpecOf(state: EditorState, text: string, options: AutoPairOptions = ALL): TransactionSpec | null {
  const main = state.selection.main
  return autoPairTypeOverSpec(state, main.from, main.to, text, options)
}

/** Applies a spec (or null) and reports the visible result. */
function applySpec(state: EditorState, spec: TransactionSpec | null) {
  if (!spec) return null
  const next = state.update(spec).state
  return {
    doc: next.doc.toString(),
    head: next.selection.main.head,
    heads: next.selection.ranges.map(r => r.head),
  }
}

/** Mirrors the adapter's dispatch order: type-over first, then insertion, else bare input. */
function typeText(state: EditorState, text: string, options: AutoPairOptions = ALL): EditorState {
  const main = state.selection.main
  const spec = autoPairTypeOverSpec(state, main.from, main.to, text, options)
    ?? autoPairSpec(state, main.from, main.to, text, options)
  return state.update(spec ?? state.replaceSelection(text)).state
}

function typeAll(state: EditorState, text: string, options: AutoPairOptions = ALL): EditorState {
  let next = state
  for (const ch of text) next = typeText(next, ch, options)
  return next
}

describe("auto pair tables are the spec's tables", () => {
  it("keeps the three pair tables and the two named sets in sync with §4.2/§4.3", () => {
    expect(BRACKET_PAIRS).toEqual({ "(": ")", "[": "]", "{": "}" })
    expect(QUOTE_PAIRS).toEqual({ '"': '"', "'": "'" })
    expect(MARKER_PAIRS).toEqual({ "*": "*", "_": "_", "`": "`", "$": "$" })
    expect(EMPTY_LINE_MARKERS).toEqual(new Set(["*", "$"]))
    expect(VERBATIM_NODES).toEqual(new Set([
      "InlineCode", "FencedCode", "CodeBlock", "InlineMath", "MathBlock", "FrontMatter",
    ]))
    // D8: CM6's ASCII set plus CJK sentence punctuation and closing marks.
    expect(CLOSE_BEFORE).toBe(")]}:;>，。、；：！？）】》”’")
  })
})

describe("rule 1: insertion (T1 + T2)", () => {
  it("inserts the closing partner and leaves the caret between the two", () => {
    const state = cursorState("", 0)
    expect(applySpec(state, insertSpecOf(state, "("))).toEqual({ doc: "()", head: 1, heads: [1] })
  })

  it("pairs before trailing whitespace", () => {
    const state = cursorState(" bar", 0)
    expect(applySpec(state, insertSpecOf(state, "("))).toMatchObject({ doc: "() bar", head: 1 })
  })

  it("refuses when the next character is prose", () => {
    expect(insertSpecOf(cursorState("foo", 0), "(")).toBeNull()
  })

  it("pairs before an existing closer", () => {
    const state = cursorState(")", 0)
    expect(applySpec(state, insertSpecOf(state, "("))).toMatchObject({ doc: "())", head: 1 })
  })

  // D8: CJK 句读/闭符号是日常路径（`这是测试|，` 打 `(`），CM6 的纯 ASCII 集合会漏掉。
  it("pairs before CJK sentence punctuation and closing marks (D8)", () => {
    const cases: Array<[string, number, string]> = [
      ["这是测试，", 4, "这是测试()，"],
      ["foo。", 3, "foo()。"],
      ["a、", 1, "a()、"],
      ["a；", 1, "a()；"],
      ["a：", 1, "a()："],
      ["a！", 1, "a()！"],
      ["a？", 1, "a()？"],
      ["a）", 1, "a()）"],
      ["a】", 1, "a()】"],
      ["a》", 1, "a()》"],
      ["a”", 1, "a()”"],
      ["a’", 1, "a()’"],
    ]
    for (const [doc, pos, expected] of cases) {
      const state = cursorState(doc, pos)
      expect(applySpec(state, insertSpecOf(state, "(")), doc).toMatchObject({ doc: expected, head: pos + 1 })
    }
  })

  it("refuses after a backslash", () => {
    expect(insertSpecOf(cursorState("\\", 1), "(")).toBeNull()
  })

  it("refuses ' after an alphanumeric but pairs it after whitespace", () => {
    expect(insertSpecOf(cursorState("don", 3), "'")).toBeNull()
    const state = cursorState("don ", 4)
    expect(applySpec(state, insertSpecOf(state, "'"))).toMatchObject({ doc: "don ''", head: 5 })
  })

  it("ignores multi-character input (paste) and empty input", () => {
    expect(autoPairSpec(cursorState("", 0), 0, 0, "()", ALL)).toBeNull()
    expect(autoPairSpec(cursorState("", 0), 0, 0, "", ALL)).toBeNull()
  })

  it("refuses when from/to is not the main selection", () => {
    const state = cursorState("ab", 2)
    expect(autoPairSpec(state, 1, 1, "(", ALL)).toBeNull()
    // Typing over a non-empty selection replaces it — never pairs (§4.5).
    const selected = EditorState.create({ doc: "ab", selection: { anchor: 0, head: 2 } })
    expect(autoPairSpec(selected, 0, 2, "(", ALL)).toBeNull()
  })

  it("covers every bracket and quote in the tables", () => {
    for (const [open, close] of Object.entries(BRACKET_PAIRS)) {
      const state = cursorState("", 0)
      expect(applySpec(state, insertSpecOf(state, open))).toMatchObject({ doc: open + close, head: 1 })
    }
    for (const [open, close] of Object.entries(QUOTE_PAIRS)) {
      const state = cursorState("", 0)
      expect(applySpec(state, insertSpecOf(state, open))).toMatchObject({ doc: open + close, head: 1 })
    }
  })

  // §7 风险表：`:` 是 emoji completion 的触发键，不在任何配对表里 —— 两条路径都不接管。
  it("leaves the emoji-completion trigger alone", () => {
    const state = cursorState("", 0)
    expect(insertSpecOf(state, ":")).toBeNull()
    expect(typeOverSpecOf(state, ":")).toBeNull()
  })
})

describe("toggle independence (§4.1)", () => {
  it("with quotes off, brackets still pair while quotes do not", () => {
    const state = cursorState("", 0)
    expect(applySpec(state, insertSpecOf(state, "(", NO_QUOTES))).toMatchObject({ doc: "()" })
    expect(insertSpecOf(state, '"', NO_QUOTES)).toBeNull()
    expect(insertSpecOf(state, "'", NO_QUOTES)).toBeNull()
  })

  it("with brackets off, quotes still pair while brackets do not", () => {
    const state = cursorState("", 0)
    expect(applySpec(state, insertSpecOf(state, '"', NO_BRACKETS))).toMatchObject({ doc: '""' })
    expect(insertSpecOf(state, "(", NO_BRACKETS)).toBeNull()
    expect(insertSpecOf(state, "{", NO_BRACKETS)).toBeNull()
  })

  it("with markdownSyntax off, markers stop pairing but T1 keeps working", () => {
    const state = cursorState("", 0)
    expect(applySpec(state, insertSpecOf(state, "(", NO_MARKERS))).toMatchObject({ doc: "()" })
    expect(insertSpecOf(markerState("", 0), "*", NO_MARKERS)).toBeNull()
  })

  it("with everything off, nothing pairs", () => {
    for (const text of ["(", "[", "{", '"', "'", "*", "_", "`", "$"]) {
      expect(insertSpecOf(markerState("", 0), text, NONE), text).toBeNull()
    }
  })
})

describe("rule 2a: a repeated Markdown marker inserts a single character", () => {
  it("refuses to pair * right after another *", () => {
    const state = markerState("**", 2)
    expect(insertSpecOf(state, "*")).toBeNull()
  })

  it("converges on **bold** when typed character by character", () => {
    const state = typeAll(markerState("", 0), "**bold**")
    expect(state.doc.toString()).toBe("**bold**")
    expect(state.selection.main.head).toBe(8)
  })
})

describe("rule 2b: only * and $ are suppressed at line start (D11)", () => {
  it("refuses * on an empty line", () => {
    expect(insertSpecOf(markerState("", 0), "*")).toBeNull()
    expect(insertSpecOf(markerState("  ", 2), "*")).toBeNull()
    expect(insertSpecOf(markerState("foo\n\n", 5), "*")).toBeNull()
  })

  it("refuses $ on an empty line and never creates a MathBlock", () => {
    const state = markerState("", 0)
    const spec = insertSpecOf(state, "$")
    expect(spec).toBeNull()
    const after = typeText(state, "$")
    expect(after.doc.toString()).toBe("$")
    let hasMathBlock = false
    syntaxTree(after).cursor().iterate(n => { if (n.name === "MathBlock") hasMathBlock = true })
    expect(hasMathBlock).toBe(false)
  })

  it("still pairs ` and _ on an empty line", () => {
    const backtick = markerState("", 0)
    expect(applySpec(backtick, insertSpecOf(backtick, "`"))).toMatchObject({ doc: "``", head: 1 })
    const underscore = markerState("", 0)
    expect(applySpec(underscore, insertSpecOf(underscore, "_"))).toMatchObject({ doc: "__", head: 1 })
  })

  it("still pairs * on a line that already has content", () => {
    const state = markerState("foo", 3)
    expect(applySpec(state, insertSpecOf(state, "*"))).toMatchObject({ doc: "foo**", head: 4 })
  })
})

describe("rule 3: stateless type-over", () => {
  it("skips over the closer without inserting anything", () => {
    const state = cursorState("()", 1)
    const spec = typeOverSpecOf(state, ")")
    expect(spec?.changes).toBeUndefined()
    const next = state.update(spec!).state
    expect(next.doc.toString()).toBe("()")
    expect(next.selection.main.head).toBe(2)
  })

  it("skips over a Markdown marker closer in prose", () => {
    const state = markerState("**", 1)
    const spec = typeOverSpecOf(state, "*")
    expect(spec).not.toBeNull()
    expect(state.update(spec!).state.selection.main.head).toBe(2)
  })

  it("does not skip a disabled marker closer", () => {
    const state = markerState("``", 1)
    expect(typeOverSpecOf(state, "`", NO_MARKERS)).toBeNull()
    expect(insertSpecOf(state, "`", NO_MARKERS)).toBeNull()
    // 退回默认管线：裸插入，而不是被静默吞掉。
    expect(typeText(state, "`", NO_MARKERS).doc.toString()).toBe("```")
  })

  it("does not skip when the character after the closer is a word character", () => {
    const state = cursorState("(x)y", 2)
    expect(typeOverSpecOf(state, ")")).toBeNull()
    // 退回默认管线：裸插入一个 `)`（而不是被当作收尾符跳过）。
    expect(typeText(state, ")").doc.toString()).toBe("(x))y")
  })

  // §4.3 规则 3 用 state.charCategorizer（默认 [\p{Alphabetic}\p{Number}_]），CJK 是词字符。
  it("treats CJK as a word character and CJK punctuation as non-word", () => {
    const cjkWord = cursorState("\"\"中", 1)
    expect(typeOverSpecOf(cjkWord, '"')).toBeNull()

    const cjkPunctuation = cursorState("\"\"，", 1)
    const spec = typeOverSpecOf(cjkPunctuation, '"')
    expect(spec).not.toBeNull()
    expect(cjkPunctuation.update(spec!).state.selection.main.head).toBe(2)
  })

  // D12：跳越候选集合与插入同源 —— verbatim 里的标记不是配对符，输入不能被吞掉。
  it("does not skip markers inside verbatim contexts (D12)", () => {
    const fence = markerState("```\n`x`\n$y$\nfoo)\n```", 6)
    expect(inVerbatim(fence, 6)).toBe(true)
    expect(typeOverSpecOf(fence, "`")).toBeNull()
    expect(insertSpecOf(fence, "`")).toBeNull()

    const math = markerState("```\n`x`\n$y$\nfoo)\n```", 10)
    expect(typeOverSpecOf(math, "$")).toBeNull()
    expect(insertSpecOf(math, "$")).toBeNull()

    const inline = markerState("x`y`", 3)
    expect(inVerbatim(inline, 3)).toBe(true)
    expect(typeOverSpecOf(inline, "`")).toBeNull()

    const inlineMath = markerState("$x$", 2)
    expect(inVerbatim(inlineMath, 2)).toBe(true)
    expect(typeOverSpecOf(inlineMath, "$")).toBeNull()
  })

  it("still skips T1 closers inside verbatim contexts (D12)", () => {
    const fence = markerState("```\n`x`\n$y$\nfoo)\n```", 15)
    expect(inVerbatim(fence, 15)).toBe(true)
    const spec = typeOverSpecOf(fence, ")")
    expect(spec).not.toBeNull()
    const next = fence.update(spec!).state
    expect(next.doc.toString()).toBe(fence.doc.toString())
    expect(next.selection.main.head).toBe(16)
  })

  it("abandons entirely when one cursor cannot skip (D10)", () => {
    // 光标 2 后面就是 ")"（可跳越），光标 5 后面是 "d" 而不是 ")"（不可跳越）→ 整体放弃，
    // 否则返回 true 会让 preventDefault 吞掉光标 5 的那次输入。
    const state = multiCursorState("ab)\ncd", 2, 5)
    expect(state.selection.main.head).toBe(5)
    expect(autoPairTypeOverSpec(state, 5, 5, ")", ALL)).toBeNull()
  })
})

describe("rule 4: pair deletion on Backspace", () => {
  it("deletes both halves when the caret sits between them", () => {
    const state = cursorState("()", 1)
    expect(applySpec(state, deletePairSpec(state, ALL))).toMatchObject({ doc: "", head: 0 })
  })

  it("deletes the pair at every cursor (D10)", () => {
    const state = multiCursorState("()\n[]", 1, 4)
    expect(applySpec(state, deletePairSpec(state, ALL))).toMatchObject({ doc: "\n", heads: [0, 1] })
  })

  it("refuses when the two neighbours are not a pair", () => {
    expect(deletePairSpec(cursorState("(xy)", 2), ALL)).toBeNull()
    expect(deletePairSpec(cursorState("ab", 1), ALL)).toBeNull()
    expect(deletePairSpec(cursorState("()", 0), ALL)).toBeNull()
  })

  it("refuses non-empty selections and readonly docs", () => {
    const selected = EditorState.create({ doc: "()", selection: { anchor: 0, head: 2 } })
    expect(deletePairSpec(selected, ALL)).toBeNull()
    const readonly = EditorState.create({
      doc: "()",
      selection: { anchor: 1 },
      extensions: [EditorState.readOnly.of(true)],
    })
    expect(deletePairSpec(readonly, ALL)).toBeNull()
  })

  it("honours the toggles", () => {
    const quotes = cursorState('""', 1)
    expect(deletePairSpec(quotes, ALL)).not.toBeNull()
    expect(deletePairSpec(quotes, NO_QUOTES)).toBeNull()
    const markers = markerState("``", 1)
    expect(deletePairSpec(markers, ALL)).not.toBeNull()
    expect(deletePairSpec(markers, NO_MARKERS)).toBeNull()
    const brackets = cursorState("()", 1)
    expect(deletePairSpec(brackets, NO_BRACKETS)).toBeNull()
  })

  // D12 的例外：成对删除不过滤上下文（对齐 CM6 deleteBracketPair）。
  it("does not filter by context, unlike type-over (D12)", () => {
    const state = markerState("```\n``\n```", 5)
    expect(inVerbatim(state, 5)).toBe(true)
    expect(applySpec(state, deletePairSpec(state, ALL))).toMatchObject({ doc: "```\n\n```", head: 4 })
  })
})

describe("§4.4 context matrix (D9)", () => {
  const CONTEXTS: Array<{ name: string; doc: string; pos: number }> = [
    { name: "InlineCode", doc: "`x` tail", pos: 3 },
    { name: "FencedCode", doc: "```\nx\n``` tail", pos: 9 },
    { name: "CodeBlock", doc: "    x tail", pos: 5 },
    { name: "InlineMath", doc: "$x$ tail", pos: 3 },
    { name: "MathBlock", doc: "$$\nm\n$$ tail", pos: 7 },
    { name: "FrontMatter", doc: "---\na: 1\n--- tail", pos: 12 },
  ]

  for (const context of CONTEXTS) {
    it(`suppresses Markdown markers but keeps brackets and quotes in ${context.name}`, () => {
      const state = markerState(context.doc, context.pos)
      expect(inVerbatim(state, context.pos)).toBe(true)
      expect(insertSpecOf(state, "*")).toBeNull()
      const bracket = insertSpecOf(state, "(")
      expect(bracket).not.toBeNull()
      const expected = context.doc.slice(0, context.pos) + "()" + context.doc.slice(context.pos)
      expect(applySpec(state, bracket)).toMatchObject({ doc: expected })
      expect(insertSpecOf(state, '"')).not.toBeNull()
    })
  }

  it("pairs markers in prose", () => {
    const state = markerState("x ", 2)
    expect(inVerbatim(state, 2)).toBe(false)
    expect(applySpec(state, insertSpecOf(state, "*"))).toMatchObject({ doc: "x **", head: 3 })
  })

  // R4：detached EditorState.create 只同步解析 ~3k 字符；从 20k 起逐个放大，直到前置条件
  // 真的成立 —— 静默不触发 D9 的测试比没有测试更糟。
  it("suppresses markers when the syntax tree has not reached the caret (D9)", () => {
    const state = largeDetachedState()
    const end = state.doc.length
    expect(syntaxTreeAvailable(state, end)).toBe(false)
    expect(inVerbatim(state, end)).toBe(true)
    expect(applySpec(state, insertSpecOf(state, "*"))).toBeNull()
  })
})

function largeDetachedState(): EditorState {
  for (const size of [20_000, 100_000, 1_000_000]) {
    const doc = `${"lorem ipsum ".repeat(Math.ceil(size / 12)).slice(0, size - 4)}tail`
    const candidate = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownLanguageSupport()],
    })
    if (!syntaxTreeAvailable(candidate, candidate.doc.length)) return candidate
  }
  throw new Error("no detached document size left the syntax tree incomplete")
}

describe("multi-selection semantics (D10)", () => {
  it("pairs at every cursor", () => {
    const state = multiCursorState("ab\ncd", 2, 5)
    expect(state.selection.main.head).toBe(5)
    const next = applySpec(state, autoPairSpec(state, 5, 5, "(", ALL))
    expect(next).toMatchObject({ doc: "ab()\ncd()", heads: [3, 8] })
  })

  it("returns null — not a partial result — when one cursor is suppressed", () => {
    // 光标 8 本可以配出一对 `**`，光标 4 在空行首被 2b 拦下 → 整体放弃。
    const state = multiCursorState("foo\n\nbar", 4, 8)
    expect(autoPairSpec(state, 8, 8, "*", ALL)).toBeNull()
    // 对照：T1 不受 2b 影响，同一组光标上 `(` 两处都配对。
    expect(applySpec(state, autoPairSpec(state, 8, 8, "(", ALL)))
      .toMatchObject({ doc: "foo\n()\nbar()", heads: [5, 11] })
  })
})

describe("undo grouping (§4.5)", () => {
  it("clears the inserted pair with a single undo", () => {
    const state = EditorState.create({ doc: "", extensions: [history()] })
    const inserted = state.update(autoPairSpec(state, 0, 0, "(", ALL)!).state
    expect(inserted.doc.toString()).toBe("()")
    let next = inserted
    const handled = undo({
      state: inserted,
      dispatch: (tr: Transaction) => { next = tr.state },
    } as unknown as EditorView)
    expect(handled).toBe(true)
    expect(next.doc.toString()).toBe("")
  })
})

describe("end-to-end typing", () => {
  it("types foo({a: \"b\"}) inside a fenced code block without a single manual closer", () => {
    const state = markerState("```\n\n```", 4)
    const typed = typeAll(state, 'foo({a: "b"})')
    expect(typed.doc.toString()).toBe('```\nfoo({a: "b"})\n```')
  })
})
