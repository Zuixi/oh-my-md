import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { collectDecorationSpecs } from "../src/decorations/build"
import { exportHtml } from "../src/export/html"
import { makeState } from "./helpers"

const names = (doc: string) => {
  const out: string[] = []
  syntaxTree(makeState(doc)).iterate({ enter: n => { out.push(n.name) } })
  return out
}

const tags = (doc: string, sel: number) => {
  const state = makeState(doc).update({ selection: { anchor: sel } }).state
  return collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
}

describe("subscript / superscript parsing", () => {
  it("parses ~x~ as Subscript and ^x^ as Superscript", () => {
    expect(names("H~2~O and x^2^ here")).toContain("Subscript")
    expect(names("H~2~O and x^2^ here")).toContain("Superscript")
  })

  it("does not treat ~~strikethrough~~ as subscript", () => {
    const n = names("~~strike~~")
    expect(n).not.toContain("Subscript")
    expect(n).toContain("Strikethrough")
  })

  it("folds the marks and applies omd-sub / omd-sup classes off-cursor", () => {
    const doc = "H~2~O and x^2^\n\nfar away"
    const t = tags(doc, doc.length)
    expect(t).toContain("mark:omd-sub")
    expect(t).toContain("mark:omd-sup")
  })
})

describe("LaTeX-style math delimiters still parse", () => {
  it("parses $ ... $ and $$ ... $$", () => {
    expect(names("energy $E=mc^2$ here")).toContain("InlineMath")
    expect(names("$$E=mc^2$$")).toContain("MathBlock")
  })
})

describe("sub/sup export", () => {
  it("exports subscript and superscript as <sub>/<sup>", () => {
    expect(exportHtml(makeState("H~2~O"))).toContain("<sub>2</sub>")
    expect(exportHtml(makeState("x^2^"))).toContain("<sup>2</sup>")
  })
})
