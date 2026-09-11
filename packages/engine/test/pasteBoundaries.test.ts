import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { normalizeBlockPaste } from "../src/paste/blockBoundaries"

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |"
const FENCE = "```js\nconst x = 1\n```"

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
