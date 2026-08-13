import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { decodeHtmlEntity } from "../src/parse/entities"
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

  it("parses <u> as Underline", () => {
    const names: string[] = []
    syntaxTree(makeState("<u>带下划线文本</u>")).iterate({ enter: n => { names.push(n.name) } })
    expect(names).toContain("Underline")
    expect(names).toContain("UnderlineMark")
    expect(names).not.toContain("HTMLTag")
  })

  it("parses HTML character references as Entity", () => {
    const names: string[] = []
    syntaxTree(makeState("hello &#x1f4da; &#128218; &amp; world")).iterate({
      enter: n => { names.push(n.name) },
    })
    expect(names.filter(n => n === "Entity")).toHaveLength(3)
  })

  it("decodes numeric emoji and named HTML entities", () => {
    expect(decodeHtmlEntity("&#x1f4da;")).toBe("📚")
    expect(decodeHtmlEntity("&#128218;")).toBe("📚")
    expect(decodeHtmlEntity("&copy;")).toBe("©")
    expect(decodeHtmlEntity("&amp;")).toBe("&")
    expect(decodeHtmlEntity("&notanentity;")).toBeNull()
    expect(decodeHtmlEntity("<script>")).toBeNull()
  })

  it("does not parse incomplete entities or HTML tags as Entity", () => {
    const names: string[] = []
    syntaxTree(makeState("hello &notanentity <script>alert(1)</script>")).iterate({
      enter: n => { names.push(n.name) },
    })
    expect(names).not.toContain("Entity")
  })
})
