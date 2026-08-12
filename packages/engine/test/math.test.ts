import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const names = (doc: string) => {
  const out: string[] = []
  syntaxTree(makeState(doc)).iterate({ enter: n => { out.push(n.name) } })
  return out
}

describe("math parsing", () => {
  it("parses single-line $$ block", () => {
    expect(names("$$E=mc^2$$")).toContain("MathBlock")
  })

  it("parses multi-line $$ block", () => {
    const n = names("$$\n\\int_0^1 x dx\n$$\n\nprose")
    expect(n).toContain("MathBlock")
    expect(n.indexOf("Paragraph")).toBeGreaterThan(n.indexOf("MathBlock"))
  })

  it("parses inline $math$", () => {
    expect(names("energy $E=mc^2$ here")).toContain("InlineMath")
  })

  it("rejects currency-ish $5 and $ x $", () => {
    expect(names("costs $5 and $6")).not.toContain("InlineMath")
    expect(names("spaced $ x $")).not.toContain("InlineMath")
  })
})

describe("math decorations", () => {
  const tags = (doc: string, sel = 0) => {
    const state = makeState(doc).update({ selection: { anchor: sel } }).state
    return collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
  }

  it("math block becomes widget off-cursor", () => {
    expect(tags("intro\n\n$$E=mc^2$$\n", 0)).toContain("widget:block:math")
  })

  it("math block shows source on-cursor", () => {
    expect(tags("$$E=mc^2$$", 3)).not.toContain("widget:block:math")
  })

  it("inline math becomes inline widget off-cursor", () => {
    // nearCursor 是行级模型：inline math 需用两行文档把光标挪到别的行
    const t = tags("intro\n\nenergy $E=mc^2$ here", 0)
    expect(t).toContain("widget:inline-math")
  })
})
