import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const tagsBetween = (doc: string, anchor: number, start: number, end: number) =>
  collectDecorationSpecs(
    makeState(doc).update({ selection: { anchor } }).state, 0, doc.length,
  ).filter(s => s.from >= start && s.from <= end).map(s => s.tag)

// 空行密度折叠（omd-empty 半高）不得进入逐字块：编辑态代码块的空行参与行号
// 行网格，被折叠后容器内出现压扁的带编号空行（回归：用户实测“非常奇怪”）。
describe("blank lines inside verbatim blocks keep full height", () => {
  it("editing fenced code: blank content lines are not omd-empty", () => {
    const doc = "intro\n\n```cpp\nint main()\n\n\nafter\n```\n\ntail"
    const fence = doc.indexOf("```cpp")
    const close = doc.lastIndexOf("```")
    expect(tagsBetween(doc, doc.indexOf("int main") + 2, fence, close))
      .not.toContain("line:omd-empty")
  })

  it("indented code block: blank lines are not omd-empty", () => {
    const doc = "text\n\n    code\n\n    more\n\nout"
    const start = doc.indexOf("    code")
    const end = doc.indexOf("    more") + 8
    expect(tagsBetween(doc, start + 4, start, end)).not.toContain("line:omd-empty")
  })

  it("math block: blank lines are not omd-empty", () => {
    const doc = "a\n\n$$\nx\n\ny\n$$\n\nb"
    const start = doc.indexOf("$$")
    const end = doc.lastIndexOf("$$")
    expect(tagsBetween(doc, start + 3, start, end)).not.toContain("line:omd-empty")
  })

  it("prose blank lines outside blocks still collapse", () => {
    const doc = "intro\n\n\noutro"
    expect(tagsBetween(doc, 0, 0, doc.length)).toContain("line:omd-empty")
  })
})
