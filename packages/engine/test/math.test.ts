import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
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
