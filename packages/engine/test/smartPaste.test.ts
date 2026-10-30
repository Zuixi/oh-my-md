import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { markdownLanguageSupport } from "../src/parse/markdown"
import {
  pasteValidationTestParseCalls,
  setPasteValidationTestSeams,
} from "../src/paste/validate"
import {
  planSmartPaste,
  preparePlainTextFallback,
  prepareSmartPaste,
  type PasteRange,
} from "../src/paste/smartPaste"
import type { PreparedSmartPaste, SmartPastePlan } from "../src/paste/model"
import { makeState } from "./helpers"

// Smart Paste 编排契约（plan 02 Task 4）。每条用例都断言 exact kind / text /
// diagnostics 与**解析次数**：整个转换最多一次本地解析，回退路径零解析。

function plain(html: string, plainText: string): PreparedSmartPaste {
  return prepareSmartPaste({ html, plainText })
}

function parsesOf(fn: () => void): number {
  const before = pasteValidationTestParseCalls()
  fn()
  return pasteValidationTestParseCalls() - before
}

/** 合成文档的顶层节点名序列（Paragraph / ATXHeading1 / …）。 */
function topLevelKinds(source: string): string[] {
  const kinds: string[] = []
  for (let child = markdownLanguageSupport().language.parser.parse(source).topNode.firstChild; child !== null; child = child.nextSibling) {
    if (!child.type.isAnonymous) kinds.push(child.name)
  }
  return kinds
}

beforeEach(() => setPasteValidationTestSeams(null))
afterEach(() => setPasteValidationTestSeams(null))

describe("planSmartPaste: plain fast path", () => {
  it("chooses the original plain text in one parse", () => {
    const prepared = plain("<p>access_token</p>", "access_token")
    const state = makeState("hello world")
    const range: PasteRange = { from: 6, to: 6 }
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, range) })).toBe(1)
    expect(plan).toEqual({ kind: "plain", text: "access_token", diagnostics: [] })
  })

  it("inserts the plain text byte-identically mid-line", () => {
    const prepared = plain("<p>some words</p>", "some words")
    const plan = planSmartPaste(prepared, makeState("hello world"), { from: 6, to: 6 })
    expect(plan.text).toBe("some words")
    expect(plan.kind).toBe("plain")
  })

  it("clamps an out-of-document range instead of throwing", () => {
    const prepared = plain("<p>access_token</p>", "access_token")
    const plan = planSmartPaste(prepared, makeState("hi"), { from: 9, to: 12 })
    expect(plan).toEqual({ kind: "plain", text: "access_token", diagnostics: [] })
  })

  it("ignores CRLF in the equivalence check but keeps the plain bytes", () => {
    const prepared = plain("<p>a<br>b</p>", "a\r\nb")
    const plan = planSmartPaste(prepared, makeState("xy"), { from: 1, to: 1 })
    expect(plan.kind).toBe("plain")
    expect(plan.text).toBe("a\r\nb")
  })
})

describe("planSmartPaste: structured candidate", () => {
  it("escapes a literal `# title` before parsing", () => {
    // trigger policy 在宿主上下文里发现行首块隐患 → 走结构化候选（转义）而不是明文。
    const prepared = plain("<p># title</p>", "# title")
    const state = makeState("hello world")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 6, to: 6 }) })).toBe(1)
    expect(plan).toEqual({ kind: "markdown", text: "\\# title", diagnostics: [] })
  })

  it("serializes a real heading without block separators when it replaces a whole line", () => {
    const prepared = plain("<h1>Title</h1>", "Title")
    const state = makeState("one\n\ntwo\n\nthree")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 5, to: 8 }) })).toBe(1)
    expect(plan).toEqual({ kind: "markdown", text: "# Title", diagnostics: [] })
  })

  it("isolates a mid-line heading as `\\n\\n# Title\\n\\n`", () => {
    const prepared = plain("<h1>Title</h1>", "Title")
    const state = makeState("hello world")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 5, to: 5 }) })).toBe(1)
    expect(plan).toEqual({ kind: "markdown", text: "\n\n# Title\n\n", diagnostics: [] })
    const next = state.update({ changes: { from: 5, to: 5, insert: plan!.text } }).state.doc.toString()
    expect(next).toBe("hello\n\n# Title\n\n world")
    expect(topLevelKinds(next)).toEqual(["Paragraph", "ATXHeading1", "Paragraph"])
  })

  it("treats a delimiter hazard inside an emphasis host as structured", () => {
    // 同一段可见文本：普通段落里 x^ 不会被读成语义，强调内部却是边界定界符。
    const prepared = plain("<p>x^</p>", "x^")
    expect(planSmartPaste(prepared, makeState("hello world"), { from: 6, to: 6 }).kind).toBe("plain")
    const inEmphasis = planSmartPaste(prepared, makeState("*a*"), { from: 1, to: 1 })
    expect(inEmphasis.kind).toBe("markdown")
    expect(inEmphasis.text).toBe("\n\nx\\^\n\n")
    expect(inEmphasis.diagnostics).toEqual([{ kind: "strictFallback", count: 1 }])
  })

  it("keeps a list item host's prefix and suffix", () => {
    const prepared = plain("<h1>Title</h1>", "Title")
    const source = "- one\n- two"
    const state = makeState(source)
    const plan = planSmartPaste(prepared, state, { from: 5, to: 5 })
    expect(plan.text).toBe("\n\n# Title")
    const next = state.update({ changes: { from: 5, to: 5, insert: plan.text } }).state.doc.toString()
    expect(next).toBe("- one\n\n# Title\n- two")
  })

  it("keeps a blockquote host intact", () => {
    const prepared = plain("<h1>Title</h1>", "Title")
    const source = "> quoted"
    const state = makeState(source)
    const plan = planSmartPaste(prepared, state, { from: source.length, to: source.length })
    expect(plan.text).toBe("\n\n# Title")
    expect(state.update({ changes: { from: 8, to: 8, insert: plan.text } }).state.doc.toString())
      .toBe("> quoted\n\n# Title")
  })

  it("lowers an unresolved asset to alt text", () => {
    const prepared = plain('<p><img src="data:image/png;base64,AAAA" alt="pic"></p>', "pic")
    const state = makeState("")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 0, to: 0 }) })).toBe(1)
    expect(plan).toEqual({
      kind: "markdown",
      text: "pic",
      diagnostics: [{ kind: "unresolvedAsset", count: 1 }],
    })
  })

  it("resolves an asset from the supplied map", () => {
    const prepared = plain('<p><img src="data:image/png;base64,AAAA" alt="pic"></p>', "pic")
    const key = prepared.assets[0].key
    const plan = planSmartPaste(prepared, makeState(""), { from: 0, to: 0 }, new Map([[key, "https://x.dev/p.png"]]))
    expect(plan).toEqual({
      kind: "markdown",
      text: "![pic](https://x.dev/p.png)",
      diagnostics: [],
    })
  })

  it("emits canonical Type 6 HTML with blank-line closure for a top-level complex table", () => {
    const html = '<table><thead><tr><th scope="col">Stage</th><th scope="col">Owner</th></tr></thead><tbody><tr><td rowspan="2">Review</td><td>Ada</td></tr><tr><td>Lin</td></tr></tbody></table>'
    const prepared = plain(html, "Stage\tOwner\nReview\tAda\nLin")
    const canonical = [
      "<table>",
      "<thead>",
      "<tr>",
      '<th scope="col">Stage</th>',
      '<th scope="col">Owner</th>',
      "</tr>",
      "</thead>",
      "<tbody>",
      "<tr>",
      '<td rowspan="2">Review</td>',
      "<td>Ada</td>",
      "</tr>",
      "<tr>",
      "<td>Lin</td>",
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n")

    const atStart = planSmartPaste(prepared, makeState(""), { from: 0, to: 0 })
    expect(atStart).toEqual({
      kind: "markdown",
      text: `${canonical}\n\n`,
      diagnostics: [],
    })

    const midLine = planSmartPaste(prepared, makeState("helloworld"), { from: 5, to: 5 })
    expect(midLine).toEqual({
      kind: "markdown",
      text: `\n\n${canonical}\n\n`,
      diagnostics: [],
    })
    const nextDoc = makeState("helloworld").update({
      changes: { from: 5, to: 5, insert: midLine.text },
    }).state.doc.toString()
    expect(topLevelKinds(nextDoc)).toEqual(["Paragraph", "HTMLBlock", "Paragraph"])
  })

  it("downgrades a complex table to visible cell text when pasted inside a list, blockquote, or unavailable host", () => {
    const html = '<table><thead><tr><th scope="col">Stage</th><th scope="col">Owner</th></tr></thead><tbody><tr><td rowspan="2">Review</td><td>Ada</td></tr><tr><td>Lin</td></tr></tbody></table>'
    const prepared = plain(html, "Stage\tOwner\nReview\tAda\nLin")

    const inList = planSmartPaste(prepared, makeState("- item"), { from: 6, to: 6 })
    expect(inList.text).not.toContain("<table")
    expect(inList.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])

    const inQuote = planSmartPaste(prepared, makeState("> quote"), { from: 7, to: 7 })
    expect(inQuote.text).not.toContain("<table")
    expect(inQuote.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])

    const unavailableState = EditorState.create({ doc: "plain host" })
    const inUnavailable = planSmartPaste(prepared, unavailableState, { from: 5, to: 5 })
    expect(inUnavailable.text).not.toContain("<table")
    expect(inUnavailable.diagnostics).toEqual([
      { kind: "strictFallback", count: 1 },
      { kind: "unsupportedTable", count: 1 },
    ])
  })
})

describe("planSmartPaste: strict fallback", () => {
  it("falls back to strict literal output when the plain candidate is rejected", () => {
    // 真解析，但候选在合成文档里被读成语义：literal 意图 → unrequestedNode。
    setPasteValidationTestSeams({
      parse: source => markdownLanguageSupport().language.parser.parse(source.replace("access_token", "**x**")),
    })
    const prepared = plain("<p>access_token</p>", "access_token")
    const state = makeState("hello world")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 6, to: 6 }) })).toBe(1)
    expect(plan).toEqual({
      kind: "markdown",
      text: "\n\naccess\\_token\n\n",
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
  })

  it("falls back to whole-fragment strict output when the structured candidate is rejected", () => {
    // 宿主 `a\` 后面直接插 `**x**`：反斜杠会把开标记吃掉 → crossingNode。
    const prepared = plain("<p><strong>x</strong></p>", "x")
    const source = "a\\ b"
    const state = makeState(source)
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 2, to: 2 }) })).toBe(1)
    expect(plan).toEqual({
      kind: "markdown",
      text: "\n\n**x**\n\n",
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
    const next = state.update({ changes: { from: 2, to: 2, insert: plan!.text } }).state.doc.toString()
    // 落单反斜杠留在原处，字面片段不跟它邻接。
    expect(next).toBe("a\\\n\n**x**\n\n b")
  })

  it("uses strict output without parsing when the syntax tree is unavailable", () => {
    // 没有挂 Markdown 语言扩展：树长度 0 → unavailable，零解析。
    const state = EditorState.create({ doc: "hello world" })
    const prepared = plain("<p>access_token</p>", "access_token")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => { plan = planSmartPaste(prepared, state, { from: 6, to: 6 }) })).toBe(0)
    expect(plan).toEqual({
      kind: "markdown",
      text: "\n\naccess\\_token\n\n",
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
  })

  it("uses strict output without parsing above the insert limit", () => {
    setPasteValidationTestSeams({ maxInsertChars: 4 })
    const prepared = plain("<p>access_token</p>", "access_token")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => {
      plan = planSmartPaste(prepared, makeState("hello world"), { from: 6, to: 6 })
    })).toBe(0)
    expect(plan).toEqual({
      kind: "markdown",
      text: "\n\naccess\\_token\n\n",
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
  })

  it("uses strict output without parsing above the context limit", () => {
    setPasteValidationTestSeams({ maxContextChars: 2 })
    const prepared = plain("<p>access_token</p>", "access_token")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => {
      plan = planSmartPaste(prepared, makeState("hello world"), { from: 6, to: 6 })
    })).toBe(0)
    expect(plan?.kind).toBe("markdown")
    expect(plan?.diagnostics).toEqual([{ kind: "strictFallback", count: 1 }])
  })

  it("emits protected visible text for a literalFallback without parsing", () => {
    const prepared = preparePlainTextFallback("# title\n$x$\n**x**")
    let plan: SmartPastePlan | undefined
    expect(parsesOf(() => {
      plan = planSmartPaste(prepared, makeState("hello world"), { from: 6, to: 6 })
    })).toBe(0)
    expect(plan).toEqual({
      kind: "markdown",
      text: "\n\n\\# title\\\n\\$x\\$\\\n\\*\\*x\\*\\*\n\n",
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
  })

  it("isolates strict literal text at a document start without extra separators", () => {
    const plan = planSmartPaste(preparePlainTextFallback("$x$"), makeState(""), { from: 0, to: 0 })
    expect(plan.text).toBe("\\$x\\$")
    expect(plan.diagnostics).toEqual([{ kind: "strictFallback", count: 1 }])
  })
})

describe("planSmartPaste: determinism", () => {
  it("returns identical plans for repeated calls", () => {
    const first = prepareSmartPaste({ html: "<h2>Title</h2><p>text</p>", plainText: "Title\ntext" })
    const second = prepareSmartPaste({ html: "<h2>Title</h2><p>text</p>", plainText: "Title\ntext" })
    expect(second).toEqual(first)
    const state = makeState("hello world")
    const range: PasteRange = { from: 5, to: 5 }
    const a = planSmartPaste(first, state, range)
    const b = planSmartPaste(first, state, range)
    expect(b).toEqual(a)
    expect(planSmartPaste(second, state, range)).toEqual(a)
  })
})
