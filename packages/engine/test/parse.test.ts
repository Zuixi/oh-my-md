import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { makeState } from "./helpers"

describe("markdown parsing", () => {
  it("parses ATX heading", () => {
    const state = makeState("# Hello")
    const names: string[] = []
    syntaxTree(state).iterate({ enter: n => { names.push(n.name) } })
    expect(names).toContain("ATXHeading1")
  })

  it("parses GFM table / task list / strikethrough", () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~del~~"
    const names: string[] = []
    syntaxTree(makeState(doc)).iterate({ enter: n => { names.push(n.name) } })
    expect(names).toContain("Table")
    expect(names).toContain("TaskMarker")   // real node name (plan said TaskMark — actual is TaskMarker)
    expect(names).toContain("Strikethrough")
  })

  it("parses CJK underscore strong emphasis", () => {
    const names: string[] = []
    syntaxTree(makeState("这是__粗体文字__使用下划线")).iterate({ enter: n => { names.push(n.name) } })
    expect(names).toContain("StrongEmphasis")
  })

  it("parses ==highlight== and <mark> as Highlight", () => {
    const eq: string[] = []
    syntaxTree(makeState("这是==高亮文本==")).iterate({ enter: n => { eq.push(n.name) } })
    expect(eq).toContain("Highlight")
    expect(eq).toContain("HighlightMark")

    const html: string[] = []
    syntaxTree(makeState("这是<mark>高亮文本</mark>")).iterate({ enter: n => { html.push(n.name) } })
    expect(html).toContain("Highlight")
    expect(html).not.toContain("HTMLTag")
  })
})
