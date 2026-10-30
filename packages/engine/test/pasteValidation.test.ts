import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import {
  pasteValidationTestParseCalls,
  setPasteValidationTestSeams,
  validatePasteCandidate,
  type PasteCandidateIntent,
  type PasteValidationResult,
} from "../src/paste/validate"
import { normalizeBlockPaste } from "../src/paste/blockBoundaries"
import { serializePasteDocument } from "../src/paste/serialize"
import { markdownLanguageSupport } from "../src/parse/markdown"
import type { PasteBlock, PasteBoundary, PasteDocument, PasteInline } from "../src/paste/model"
import { makeState } from "./helpers"

const INLINE: PasteBoundary = { start: "inline", end: "inline" }
const BLOCK: PasteBoundary = { start: "block", end: "block" }
const OPAQUE: PasteBoundary = { start: "block", end: "opaque" }

const text = (value: string): PasteInline => ({ type: "text", value })
const strong = (...children: PasteInline[]): PasteInline => ({ type: "strong", children })
const emphasis = (...children: PasteInline[]): PasteInline => ({ type: "emphasis", children })
const paragraph = (...children: PasteInline[]): PasteBlock => ({ type: "paragraph", children })
const heading = (level: 1 | 2 | 3 | 4 | 5 | 6, ...children: PasteInline[]): PasteBlock =>
  ({ type: "heading", level, children })

function doc(...blocks: PasteBlock[]): PasteDocument {
  return { blocks }
}

const literal: PasteCandidateIntent = { kind: "literal" }
const structured = (document: PasteDocument): PasteCandidateIntent => ({ kind: "structured", document })

interface Outcome {
  readonly result: PasteValidationResult
  readonly parses: number
}

function run(
  source: string,
  from: number,
  to: number,
  insert: string,
  boundary: PasteBoundary,
  intent: PasteCandidateIntent,
): Outcome {
  const state = makeState(source)
  const before = pasteValidationTestParseCalls()
  const result = validatePasteCandidate({ state, range: { from, to }, text: insert, boundary, intent })
  return { result, parses: pasteValidationTestParseCalls() - before }
}

function expectOutsidePreserved(source: string, from: number, to: number, insert: string) {
  const next = makeState(source).update({ changes: { from, to, insert } }).state.doc.toString()
  expect(next.startsWith(source.slice(0, from))).toBe(true)
  expect(next.endsWith(source.slice(to))).toBe(true)
}

function accepted(outcome: Outcome) {
  expect(outcome.result).toEqual({ kind: "accepted" })
  expect(outcome.parses).toBe(1)
}

function rejected(outcome: Outcome, reason: string) {
  expect(outcome.result).toEqual({ kind: "rejected", reason })
  expect(outcome.parses).toBe(1)
}

beforeEach(() => setPasteValidationTestSeams(null))
afterEach(() => setPasteValidationTestSeams(null))

describe("validatePasteCandidate: inline candidates", () => {
  it("accepts emphasis inserted mid-paragraph in one parse", () => {
    accepted(run("hello world", 6, 6, "**bold**", INLINE, structured(doc(paragraph(strong(text("bold")))))))
  })

  it("accepts plain visible text without requested semantics", () => {
    accepted(run("hello world", 6, 6, "access_token", INLINE, literal))
  })

  it("keeps a blockquote host intact", () => {
    const source = "> quoted text"
    accepted(run(source, 9, 9, "**x**", INLINE, structured(doc(paragraph(strong(text("x")))))))
    expectOutsidePreserved(source, 9, 9, "**x**")
  })

  it("keeps a list item host intact", () => {
    const source = "- one\n- two"
    accepted(run(source, 8, 8, " two", INLINE, literal))
    expectOutsidePreserved(source, 8, 8, " two")
  })

  it("rejects a paste that splits a link label", () => {
    rejected(run("see [label](u) here", 8, 8, "x", INLINE, literal), "crossingNode")
  })

  it("rejects emphasis that swallows a neighbouring delimiter", () => {
    // 插入点落在既有 `*ab*` 的收尾定界符之前：候选会跨进固定 suffix。
    rejected(run("*ab* cd", 3, 3, "x", INLINE, literal), "crossingNode")
  })

  it("rejects a dangling backslash that escapes the candidate", () => {
    rejected(
      run("a\\ b", 2, 2, "*x*", INLINE, structured(doc(paragraph(emphasis(text("x")))))),
      "crossingNode",
    )
  })

  it("rejects literal text that would render as emphasis", () => {
    rejected(run("text", 0, 0, "*x*", INLINE, literal), "unrequestedNode")
  })

  it("rejects literal text that would create HTML, math, or a link", () => {
    rejected(run("text", 0, 0, "<b>x</b>", INLINE, literal), "unrequestedNode")
    rejected(run("text", 0, 0, "$x$", INLINE, literal), "unrequestedNode")
    rejected(run("text", 0, 0, "[t](u)", INLINE, literal), "unrequestedNode")
  })

  it("rejects structured content that introduces unrequested inline semantics", () => {
    rejected(run("", 0, 0, "**x**", INLINE, structured(doc(paragraph(text("x"))))), "inlineCount")
  })

  it("leaves source outside the replacement range untouched", () => {
    const source = "hello world"
    const state = makeState(source)
    const result = validatePasteCandidate({
      state,
      range: { from: 6, to: 6 },
      text: "**bold**",
      boundary: INLINE,
      intent: structured(doc(paragraph(strong(text("bold"))))),
    })
    expect(result).toEqual({ kind: "accepted" })
    expect(state.doc.toString()).toBe(source)
    expectOutsidePreserved(source, 6, 6, "**bold**")
  })
})

describe("validatePasteCandidate: block candidates", () => {
  it("accepts a separated heading inserted mid-line", () => {
    // plan 02 Task 4 的典型案例：hello / Heading / world，而不是被吸进段落。
    const insert = normalizeBlockPaste(makeState("hello world").doc, 5, 5, "# Title").text
    expect(insert).toBe("\n\n# Title\n\n")
    accepted(run("hello world", 5, 5, insert, BLOCK, structured(doc(heading(1, text("Title"))))))
  })

  it("rejects an unseparated heading that the host paragraph absorbs", () => {
    rejected(run("hello world", 5, 5, "# Title", BLOCK, structured(doc(heading(1, text("Title"))))), "boundary")
  })

  it("accepts a list pasted after a paragraph", () => {
    const list: PasteBlock = {
      type: "list",
      ordered: false,
      start: null,
      items: [{ checked: null, children: [paragraph(text("a"))] }, { checked: null, children: [paragraph(text("b"))] }],
    }
    accepted(run("para\n\n", 6, 6, "- a\n- b\n", BLOCK, structured(doc(list))))
  })

  it("accepts an opaque table at the beginning of the document", () => {
    const table: PasteBlock = {
      type: "table",
      table: {
        rows: [
          { cells: [{ header: true, scope: "col", rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("a"))] }] },
          { cells: [{ header: false, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("1"))] }] },
        ],
        requiresComplexHtml: false,
      },
    }
    accepted(run("", 0, 0, "| a |\n| --- |\n| 1 |\n", OPAQUE, structured(doc(table))))
  })

  it("accepts a selected range that spans block boundaries", () => {
    const source = "one\n\ntwo\n\nthree"
    const outcome = run(source, 5, 8, "\n\n# H\n\n", BLOCK, structured(doc(heading(1, text("H")))))
    accepted(outcome)
    expectOutsidePreserved(source, 5, 8, "\n\n# H\n\n")
  })

  it("rejects a block whose kind differs from the requested one", () => {
    rejected(
      run("", 0, 0, "> quoted\n", BLOCK, structured(doc(paragraph(text("quoted"))))),
      "blockKind",
    )
  })

  it("rejects literal text that would open a heading block", () => {
    rejected(run("text\n\n", 6, 6, "# hi\n", BLOCK, literal), "unrequestedNode")
  })

  it("rejects literal text that would open a table", () => {
    rejected(run("", 0, 0, "| a |\n| --- |\n", OPAQUE, literal), "unrequestedNode")
  })
})

describe("validatePasteCandidate: synthetic parse shape", () => {
  it("parses prefix + candidate + suffix exactly once", () => {
    const sources: string[] = []
    setPasteValidationTestSeams({
      parse: source => {
        sources.push(source)
        return markdownLanguageSupport().language.parser.parse(source)
      },
    })
    const outcome = run("hello world", 6, 6, "**bold**", INLINE, structured(doc(paragraph(strong(text("bold"))))))
    expect(outcome.result).toEqual({ kind: "accepted" })
    expect(outcome.parses).toBe(1)
    expect(sources).toEqual(["hello **bold**world"])
  })
})

describe("validatePasteCandidate: guards", () => {
  it("returns unavailable without parsing when the tree does not cover the range", () => {
    // 没有挂 Markdown 语言扩展：语法树长度 0，必须保守退出且不解析。
    const state = EditorState.create({ doc: "hello world" })
    const before = pasteValidationTestParseCalls()
    const result = validatePasteCandidate({
      state,
      range: { from: 0, to: 0 },
      text: "x",
      boundary: INLINE,
      intent: literal,
    })
    expect(result).toEqual({ kind: "unavailable" })
    expect(pasteValidationTestParseCalls() - before).toBe(0)
  })

  it("returns unavailable for an out-of-range replacement", () => {
    const state = makeState("short")
    expect(validatePasteCandidate({
      state,
      range: { from: 3, to: 9 },
      text: "x",
      boundary: INLINE,
      intent: literal,
    })).toEqual({ kind: "unavailable" })
  })

  it("accepts an empty candidate without parsing", () => {
    const outcome = run("hello", 2, 2, "", INLINE, literal)
    expect(outcome.result).toEqual({ kind: "accepted" })
    expect(outcome.parses).toBe(0)
  })
})

describe("validatePasteCandidate: named limits", () => {
  const LIMIT = { maxContextChars: 16, maxInsertChars: 16 }

  it("parses an insertion exactly at the insert limit and refuses above it", () => {
    setPasteValidationTestSeams(LIMIT)
    expect(pasteValidationTestParseCalls()).toBe(0)
    const below = run("", 0, 0, "x".repeat(15), INLINE, literal)
    expect(below.result).toEqual({ kind: "accepted" })
    expect(below.parses).toBe(1)

    const at = run("", 0, 0, "x".repeat(16), INLINE, literal)
    expect(at.result).toEqual({ kind: "accepted" })
    expect(at.parses).toBe(1)

    const above = run("", 0, 0, "x".repeat(17), INLINE, literal)
    expect(above.result).toEqual({ kind: "limit" })
    expect(above.parses).toBe(0)
  })

  it("parses a prefix context exactly at the context limit and refuses above it", () => {
    setPasteValidationTestSeams(LIMIT)
    for (const size of [15, 16]) {
      const outcome = run(`${"x".repeat(size)}\n\nrest`, size, size, "z", INLINE, literal)
      expect(outcome.result).toEqual({ kind: "accepted" })
      expect(outcome.parses).toBe(1)
    }
    const above = run(`${"x".repeat(17)}\n\nrest`, 17, 17, "z", INLINE, literal)
    expect(above.result).toEqual({ kind: "limit" })
    expect(above.parses).toBe(0)
  })

  it("parses a suffix context exactly at the context limit and refuses above it", () => {
    setPasteValidationTestSeams(LIMIT)
    for (const size of [15, 16]) {
      const source = `abc\n${"y".repeat(size)}\n\nzz`
      const outcome = run(source, 4, 4, "z", INLINE, literal)
      expect(outcome.result).toEqual({ kind: "accepted" })
      expect(outcome.parses).toBe(1)
    }
    const above = run(`abc\n${"y".repeat(17)}\n\nzz`, 4, 4, "z", INLINE, literal)
    expect(above.result).toEqual({ kind: "limit" })
    expect(above.parses).toBe(0)
  })

  it("never parses a candidate above the production insert limit", () => {
    const state = makeState("")
    const before = pasteValidationTestParseCalls()
    const result = validatePasteCandidate({
      state,
      range: { from: 0, to: 0 },
      text: "x".repeat(262_145),
      boundary: INLINE,
      intent: literal,
    })
    expect(result).toEqual({ kind: "limit" })
    expect(pasteValidationTestParseCalls() - before).toBe(0)
  })
})

describe("validatePasteCandidate: serializer round trip", () => {
  const inline = (...children: PasteInline[]): PasteDocument => doc(paragraph(...children))
  const cases: readonly {
    readonly name: string
    readonly document: PasteDocument
    readonly host?: string
    readonly from?: number
  }[] = [
    { name: "strong/emphasis/strike", document: inline(strong(emphasis(text("a"))), text(" "), { type: "strike", children: [text("b")] }) },
    { name: "highlight/underline", document: inline({ type: "highlight", children: [text("a")] }, { type: "underline", children: [text("b")] }) },
    { name: "kbd", document: inline({ type: "kbd", children: [strong(text("Ctrl"))] }) },
    { name: "sub/sup", document: inline({ type: "subscript", children: [text("a")] }, { type: "superscript", children: [text("b")] }) },
    { name: "code span", document: inline({ type: "code", value: "a`b" }) },
    { name: "link", document: inline({ type: "link", href: "https://example.com", title: "t", children: [text("l")] }) },
    { name: "image", document: inline({ type: "image", alt: "i", title: null, source: { kind: "url", value: "https://example.com/i.png" } }) },
    { name: "hard break", document: inline(text("a"), { type: "hardBreak" }, text("b")) },
    { name: "heading 3", document: doc(heading(3, text("Title"))) },
    { name: "blockquote", document: doc({ type: "blockquote", children: [paragraph(text("q"))] }) },
    { name: "ordered list", document: doc({ type: "list", ordered: true, start: 3, items: [{ checked: null, children: [paragraph(text("a"))] }, { checked: null, children: [paragraph(text("b"))] }] }) },
    { name: "task list", document: doc({ type: "list", ordered: false, start: null, items: [{ checked: true, children: [paragraph(text("a"))] }, { checked: false, children: [paragraph(text("b"))] }] }) },
    { name: "fenced code", document: doc({ type: "codeBlock", language: "js", value: "const x = 1\n" }) },
    { name: "horizontal rule", document: doc({ type: "horizontalRule" }), host: "text\n\n", from: 6 },
    { name: "literal markdown text", document: inline(text("# not a heading"), text(" **not strong**")) },
    { name: "paragraph into a paragraph host", document: inline(strong(text("x"))), host: "before after", from: 7 },
  ]

  for (const sample of cases) {
    it(`accepts the serialized ${sample.name} candidate`, () => {
      const source = sample.host ?? ""
      const from = sample.from ?? 0
      const state = makeState(source)
      const serialized = serializePasteDocument(sample.document, { mode: "minimal", resolveAsset: () => null })
      const insert = normalizeBlockPaste(state.doc, from, from, serialized.text).text
      const outcome = run(source, from, from, insert, serialized.boundary, structured(sample.document))
      expect(outcome.result).toEqual({ kind: "accepted" })
      expect(outcome.parses).toBe(1)
    })
  }

  it("rejects a horizontal rule pasted at the top of the document", () => {
    // 文档开头的 `---` 是 FrontMatter，不是 HorizontalRule：块种类必须不符。
    const rule: PasteDocument = doc({ type: "horizontalRule" })
    rejected(run("", 0, 0, "---\n", OPAQUE, structured(rule)), "blockKind")
  })
})
