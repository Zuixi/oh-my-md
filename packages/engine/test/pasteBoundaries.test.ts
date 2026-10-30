import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { normalizeBlockPaste } from "../src/paste/blockBoundaries"
import type { PasteBoundary } from "../src/paste/model"

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |"
const FENCE = "```js\nconst x = 1\n```"

const INLINE: PasteBoundary = { start: "inline", end: "inline" }
const BLOCK: PasteBoundary = { start: "block", end: "block" }
const OPAQUE: PasteBoundary = { start: "block", end: "opaque" }
const HTML_BLOCK: PasteBoundary = { start: "block", end: "htmlBlock" }

function docOf(content: string) {
  return EditorState.create({ doc: content }).doc
}

describe("normalizeBlockPaste", () => {
  it("leaves plain paragraph text byte-identical", () => {
    const r = normalizeBlockPaste(docOf("hello world"), 5, 5, "plain **text**")
    expect(r).toEqual({ text: "plain **text**", caret: 14 })
  })

  it("appends one newline when a table is pasted into an empty document", () => {
    // 光标停在新空行上，不压 Table 节点的 to 边界 —— 粘贴即渲染。
    expect(normalizeBlockPaste(docOf(""), 0, 0, TABLE))
      .toEqual({ text: `${TABLE}\n`, caret: TABLE.length + 1 })
  })

  it("splits a mid-line paste into its own block with blank-line separation", () => {
    const r = normalizeBlockPaste(docOf("foo bar"), 3, 3, TABLE)
    expect(r.text).toBe(`\n\n${TABLE}\n\n`)
    expect(r.caret).toBe(r.text.length)
  })

  it("prevents trailing same-line text from being swallowed by the pasted table", () => {
    // 复现过的内容损坏：`foobar` 词中粘表，bar 被吸收进最后一格。
    const r = normalizeBlockPaste(docOf("foobar"), 3, 3, TABLE)
    expect(r.text).toBe(`\n\n${TABLE}\n\n`)
  })

  it("prepends one newline at a line start whose previous line is non-blank", () => {
    // 表格/围栏不能打断段落：需要在块前补出空行。
    const r = normalizeBlockPaste(docOf("prev\ntext"), 5, 5, "- item")
    expect(r.text).toBe("\n- item\n\n")
  })

  it("adds nothing when the previous line is already blank", () => {
    const r = normalizeBlockPaste(docOf("prev\n\n\nnext"), 6, 6, "- item")
    expect(r.text).toBe("- item")
  })

  it("adds nothing at the beginning of the document", () => {
    expect(normalizeBlockPaste(docOf("next"), 0, 0, "- item").text).toBe("- item\n\n")
  })

  it("ends a pasted fenced block with a newline so the caret is off the replace boundary", () => {
    const r = normalizeBlockPaste(docOf("x"), 1, 1, FENCE)
    expect(r.text).toBe(`\n\n${FENCE}\n`)
    expect(r.caret).toBe(r.text.length)
  })

  it("treats a horizontal rule as an opaque block end", () => {
    expect(normalizeBlockPaste(docOf(""), 0, 0, "***").text).toBe("***\n")
  })

  it("does not append a newline after non-opaque blocks like headings or lists", () => {
    expect(normalizeBlockPaste(docOf(""), 0, 0, "# Title")).toEqual({ text: "# Title", caret: 7 })
    expect(normalizeBlockPaste(docOf(""), 0, 0, "- a")).toEqual({ text: "- a", caret: 3 })
  })

  it("treats a table row as the opaque end only on the last line", () => {
    // 围栏闭合在末行 → opaque；围栏内容中的 | 行不影响判定。
    expect(normalizeBlockPaste(docOf(""), 0, 0, "```js\nconst x = 1\n```").text).toBe(`${FENCE}\n`)
    expect(normalizeBlockPaste(docOf(""), 0, 0, "```\n| a |\n```").text).toBe("```\n| a |\n```\n")
  })
})

// 边界感知模式（plan 02 Task 4）：serializer 给出 PasteBoundary 时，块/不透明
// 片段即使文本不像块也独占块位，行首前一行非空时用空行分隔。
describe("normalizeBlockPaste with a host boundary", () => {
  function inserted(doc: string, from: number, to: number, insert: string, boundary: PasteBoundary) {
    const source = docOf(doc)
    const result = normalizeBlockPaste(source, from, to, insert, boundary)
    const next = EditorState.create({ doc }).update({ changes: { from, to, insert: result.text } }).state.doc.toString()
    expect(result.caret).toBe(result.text.length)
    // stable prefix/suffix 逐字节保留：规整只插入分隔，绝不重写宿主源码。
    expect(next.startsWith(doc.slice(0, from))).toBe(true)
    expect(next.endsWith(doc.slice(to))).toBe(true)
    return result.text
  }

  it("splits a mid-line insertion into its own block", () => {
    expect(inserted("hello world", 5, 5, "# Title", BLOCK)).toBe("\n\n# Title\n\n")
  })

  it("keeps an inline fragment byte-identical", () => {
    expect(inserted("hello world", 5, 5, "access_token", INLINE)).toBe("access_token")
    expect(inserted("hello world", 5, 5, "**bold**", INLINE)).toBe("**bold**")
  })

  it("isolates a strict literal fragment mid-line", () => {
    expect(inserted("hello world", 5, 5, String.raw`\*x\*`, BLOCK)).toBe("\n\n" + String.raw`\*x\*` + "\n\n")
  })

  it("keeps one blank line before a block at a line start whose previous line is text", () => {
    // 遗留路径只补一个换行；边界感知模式必须补空行（表格/围栏不能打断段落）。
    expect(normalizeBlockPaste(docOf("prev\ntext"), 5, 5, "- item").text).toBe("\n- item\n\n")
    expect(inserted("prev\ntext", 5, 5, "- item", BLOCK)).toBe("\n\n- item\n\n")
    expect(inserted("prev\n\n", 6, 6, TABLE, OPAQUE)).toBe(`${TABLE}\n`)
  })

  it("isolates a block fragment inside a list item and a blockquote", () => {
    expect(inserted("- one two", 5, 5, "- x", BLOCK)).toBe("\n\n- x\n\n")
    expect(inserted("> quoted", 8, 8, "# H", BLOCK)).toBe("\n\n# H")
  })

  it("trusts an opaque end even when the last line looks inline", () => {
    const text = inserted("", 0, 0, "| a |\n| --- |", OPAQUE)
    expect(text).toBe("| a |\n| --- |\n")
  })

  it("preserves a selected range spanning block boundaries", () => {
    expect(inserted("one\n\ntwo\n\nthree", 5, 8, "\n\n# H\n\n", BLOCK)).toBe("\n\n# H\n\n")
    expect(inserted("one\n\ntwo\n\nthree", 0, 3, "# H", BLOCK)).toBe("# H")
  })

  it("does not let a dangling backslash eat the isolated fragment", () => {
    // 宿主 `a\` + 直接插入 `\*x\*` 会变成 `a\\*x*`（转义反被消费）；空行隔开就没有邻接。
    expect(inserted("a\\ b", 2, 2, String.raw`\*x\*`, BLOCK)).toBe("\n\n" + String.raw`\*x\*` + "\n\n")
  })

  it("does not let adjacent emphasis or link delimiters eat the fragment", () => {
    expect(inserted("*ab* cd", 3, 3, String.raw`\*x\*`, BLOCK)).toBe("\n\n" + String.raw`\*x\*` + "\n\n")
    expect(inserted("see [label](u) here", 8, 8, String.raw`\[x\]`, BLOCK))
      .toBe("\n\n" + String.raw`\[x\]` + "\n\n")
  })

  it("closes an htmlBlock end with a blank line at EOF and mid-line so subsequent text is not absorbed", () => {
    const canonical = "<table>\n<tbody>\n<tr>\n<td>a</td>\n</tr>\n</tbody>\n</table>"
    expect(inserted("", 0, 0, canonical, HTML_BLOCK)).toBe(`${canonical}\n\n`)
    expect(inserted("helloworld", 5, 5, canonical, HTML_BLOCK)).toBe(`\n\n${canonical}\n\n`)
    expect(inserted("prev\n\n", 6, 6, canonical, HTML_BLOCK)).toBe(`${canonical}\n\n`)
  })
})
