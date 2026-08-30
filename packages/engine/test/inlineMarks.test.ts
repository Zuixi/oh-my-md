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

// 非空选区（拖选 / Shift+方向键 / Cmd+A）不显源码 —— 选区是视觉的，光标才是编辑。
const tagsRange = (doc: string, anchor: number, head: number) => {
  const state = makeState(doc).update({ selection: { anchor, head } }).state
  return collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
}

describe("non-caret selections keep marks folded (selection is visual)", () => {
  it("keeps emphasis marks folded while a selection crosses them", () => {
    const doc = "plain **bold** plain"
    const folded = tagsRange(doc, 0, doc.length)
    expect(folded).toContain("replace:EmphasisMark")
    expect(folded).toContain("mark:omd-strong")
    // 部分行选区压住 ** 也不展开（旧 cursorInside 的重叠分支曾在此显源码）
    const partial = tagsRange(doc, 6, 9)
    expect(partial).toContain("replace:EmphasisMark")
    // 路线 A：caret 进入也不展开（点击只定位光标；增删改走 toggle 命令）
    expect(tags(doc, 8)).toContain("replace:EmphasisMark")
  })

  it("keeps the heading mark folded while its line is selected", () => {
    const doc = "# Title\nbody\n"
    // 选区头在标题行上（旧 nearCursor 按 head 行展开整行标记）
    const sel = tagsRange(doc, 0, 5)
    expect(sel).toContain("replace:HeaderMark")
    // 路线 A：caret 在标题行也不展开
    expect(tags(doc, 3)).toContain("replace:HeaderMark")
  })

  it("keeps link URL folded while a selection crosses the link", () => {
    const doc = "see [text](http://x.com) here"
    const folded = tagsRange(doc, 0, doc.length)
    expect(folded).toContain("replace:LinkMark")
    expect(folded).toContain("replace:URL")
  })
})

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
