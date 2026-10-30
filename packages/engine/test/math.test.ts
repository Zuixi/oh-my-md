import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const names = (doc: string) => {
  const out: string[] = []
  syntaxTree(makeState(doc)).iterate({ enter: n => { out.push(n.name) } })
  return out
}

// 精确源码区间：转义契约是“内容保留原文”，只断言节点名会漏掉截断。
const nodeText = (doc: string, name: string) => {
  const state = makeState(doc)
  const out: string[] = []
  syntaxTree(state).iterate({
    enter: n => { if (n.name === name) out.push(state.doc.sliceString(n.from, n.to)) },
  })
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

describe("inline math escape contract", () => {
  it("rejects an escaped opening $", () => {
    expect(nodeText("a \\$x$ b", "InlineMath")).toEqual([])
  })

  it("keeps the opening when the backslash run is even", () => {
    expect(nodeText("a \\\\$x$ b", "InlineMath")).toEqual(["$x$"])
  })

  it("skips an escaped closing $ and closes at the next unescaped one", () => {
    const doc = "$x\\$y$"
    expect(nodeText(doc, "InlineMath")).toEqual([doc])
    // 被转义的 $ 仍属于内容：不产生内嵌 InlineMath，也没有截断在第一个 $
    expect(nodeText(doc, "InlineMath")).toHaveLength(1)
  })

  it("closes at an even-backslash $ because that $ is not escaped", () => {
    // `$x\\$` 里 $ 前是两个反斜杠 → 未转义，是真正的 closing
    expect(nodeText("$x\\\\$y$", "InlineMath")).toEqual(["$x\\\\$"])
  })

  it("rejects an unterminated pair whose only closer is escaped", () => {
    expect(nodeText("$x\\$", "InlineMath")).toEqual([])
  })

  it("keeps existing boundary rules with escapes in play", () => {
    expect(names("$$x$$")).not.toContain("InlineMath")
    expect(names("$ x\\$y$")).not.toContain("InlineMath")
    expect(names("$x\\$y $")).not.toContain("InlineMath")
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
