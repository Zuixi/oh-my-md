import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { collectDecorationSpecs } from "../src/decorations/build"
import { parseCell } from "../src/parse/cell"
import { makeState } from "./helpers"

// `<kbd>` 是固定 HTML 对（与 `<mark>`/`<u>` 同一个 parseHtmlPair 机制），不是通用
// HTML 配对栈：只有无属性的开闭标签、大小写不敏感、闭合搜索跳过行内代码，
// 属性/未闭合/跨块/转义 opener 一律退回可见源码。

const names = (doc: string) => {
  const out: string[] = []
  syntaxTree(makeState(doc)).iterate({ enter: n => { out.push(n.name) } })
  return out
}

/** 精确源码区间：这套规则的全部意义就是 Kbd 节点框住了哪一段字节。 */
const nodeText = (doc: string, name: string) => {
  const state = makeState(doc)
  const out: string[] = []
  syntaxTree(state).iterate({
    enter: n => { if (n.name === name) out.push(state.doc.sliceString(n.from, n.to)) },
  })
  return out
}

const specs = (doc: string, sel: number) => {
  const state = makeState(doc).update({ selection: { anchor: sel } }).state
  return collectDecorationSpecs(state, 0, doc.length)
}

const tags = (doc: string, sel: number) => specs(doc, sel).map(spec => spec.tag)

describe("fixed <kbd> pair parsing", () => {
  it("parses `<kbd>Ctrl</kbd>` as Kbd(KbdMark, content, KbdMark)", () => {
    const doc = "<kbd>Ctrl</kbd>"
    const state = makeState(doc)
    const kbd = syntaxTree(state).topNode.getChild("Paragraph")?.getChild("Kbd")
    expect(kbd).not.toBeNull()
    expect(kbd?.name).toBe("Kbd")
    expect(doc.slice(kbd!.from, kbd!.to)).toBe(doc)
    expect(kbd!.firstChild?.name).toBe("KbdMark")
    expect(doc.slice(kbd!.firstChild!.from, kbd!.firstChild!.to)).toBe("<kbd>")
    const last = kbd!.lastChild!
    expect(doc.slice(last.from, last.to)).toBe("</kbd>")
    // 内容仍是普通 inline：Kbd 只提供固定 tag marker，不接管内层语义。
    expect(doc.slice(kbd!.firstChild!.to, last.from)).toBe("Ctrl")
    expect(names(doc)).toContain("KbdMark")
  })

  it("keeps nested inline semantics inside the pair", () => {
    expect(names("<kbd>**b** `c` *i*</kbd>")).toEqual(
      expect.arrayContaining(["Kbd", "StrongEmphasis", "InlineCode", "Emphasis"]),
    )
    expect(nodeText("<kbd>**b**</kbd>", "Kbd")).toEqual(["<kbd>**b**</kbd>"])
  })

  it("accepts the fixed case/whitespace shape", () => {
    expect(nodeText("<KBD>x</kbd>", "Kbd")).toEqual(["<KBD>x</kbd>"])
    expect(nodeText("<kbd >x</KBD >", "Kbd")).toEqual(["<kbd >x</KBD >"])
    expect(nodeText("a <kbd>K</kbd> b <kbd>J</kbd>", "Kbd")).toEqual(["<kbd>K</kbd>", "<kbd>J</kbd>"])
  })

  it("skips a same-name closing tag inside a complete code span", () => {
    expect(nodeText("<kbd>`</kbd>`x</kbd>", "Kbd")).toEqual(["<kbd>`</kbd>`x</kbd>"])
  })

  it("closes at the first tag when no code span intervenes", () => {
    expect(nodeText("<kbd>a</kbd>b</kbd>", "Kbd")).toEqual(["<kbd>a</kbd>"])
  })

  it("treats an unclosed code span as its opener and closes after it", () => {
    expect(nodeText("<kbd>`</kbd>x</kbd>", "Kbd")).toEqual(["<kbd>`</kbd>"])
  })
})

describe("invalid <kbd> forms stay visible source", () => {
  it("rejects an opener with attributes", () => {
    expect(nodeText("<kbd class=\"x\">Ctrl</kbd>", "Kbd")).toEqual([])
  })

  it("rejects an unclosed pair", () => {
    expect(nodeText("<kbd>Ctrl", "Kbd")).toEqual([])
    expect(nodeText("a <kbd>Ctrl b", "Kbd")).toEqual([])
  })

  it("rejects a cross-paragraph pair", () => {
    expect(nodeText("<kbd>a\n\nb</kbd>", "Kbd")).toEqual([])
    // 同一段落内的软换行不是跨块：段落是 inline 上下文边界，块不是。
    expect(nodeText("<kbd>a\nb</kbd>", "Kbd")).toEqual(["<kbd>a\nb</kbd>"])
  })

  it("rejects an escaped opener, keeping an even backslash run as an opener", () => {
    expect(nodeText("a \\<kbd>x</kbd> b", "Kbd")).toEqual([])
    expect(nodeText("a \\\\<kbd>x</kbd> b", "Kbd")).toEqual(["<kbd>x</kbd>"])
  })

  it("rejects a closer with attributes", () => {
    expect(nodeText("<kbd>x</kbd class=\"x\">", "Kbd")).toEqual([])
  })
})

describe("Live Preview folds only the markers", () => {
  const DOC = "<kbd>Ctrl</kbd> and more"

  it("replaces exactly the two KbdMark ranges", () => {
    const found = specs(DOC, DOC.length).filter(spec => spec.tag.startsWith("replace:"))
    expect(found.map(spec => spec.tag)).toEqual(["replace:KbdMark", "replace:KbdMark"])
    expect(found.map(spec => [spec.from, spec.to])).toEqual([[0, 5], [9, 15]])
  })

  it("marks the visible content semantically as omd-kbd", () => {
    const marks = specs(DOC, DOC.length).filter(spec => spec.tag === "mark:omd-kbd")
    expect(marks.map(spec => [spec.from, spec.to])).toEqual([[0, 15]])
  })

  it("never replaces the visible content", () => {
    const content = { from: 5, to: 9 } // 'Ctrl'
    for (const spec of specs(DOC, DOC.length)) {
      if (!spec.tag.startsWith("replace:") && !spec.tag.startsWith("widget:")) continue
      expect(spec.to <= content.from || spec.from >= content.to).toBe(true)
    }
  })

  it("folds unconditionally (Route A: the caret never reveals fixed markers)", () => {
    expect(tags(DOC, 6)).toContain("replace:KbdMark")
    expect(tags(DOC, 6)).toContain("mark:omd-kbd")
  })
})

describe("cell projection", () => {
  it("projects `<kbd>Ctrl</kbd>` as a kbd container without its tag markers", () => {
    expect(parseCell("<kbd>Ctrl</kbd>")).toEqual([
      { type: "kbd", children: [{ type: "text", text: "Ctrl" }] },
    ])
  })

  it("keeps nested inline semantics inside the container", () => {
    expect(parseCell("<kbd>*b* `c`</kbd>")).toEqual([{
      type: "kbd",
      children: [
        { type: "em", children: [{ type: "text", text: "b" }] },
        { type: "text", text: " " },
        { type: "code", text: "c" },
      ],
    }])
    const mixed = parseCell("H~2~O <kbd>Ctrl</kbd> **b**")
    expect(mixed.map(node => node.type)).toEqual(["text", "sub", "text", "kbd", "text", "strong"])
  })

  it("keeps invalid forms as visible literal cell text", () => {
    // HTMLTag 与相邻文本各自成节点（与 `<br>`/未知标签同样的既有形状）；
    // 重要的是每个字节都还在、没有 kbd 容器。
    for (const source of ["<kbd class=\"x\">Ctrl</kbd>", "<kbd>Ctrl"]) {
      const nodes = parseCell(source)
      expect(nodes.some(node => node.type === "kbd")).toBe(false)
      expect(nodes.map(node => (node.type === "text" ? node.text : "")).join("")).toBe(source)
    }
  })

  it("does not treat a same-name close inside inline code as the pair end", () => {
    expect(parseCell("<kbd>`</kbd>`x</kbd>")).toEqual([{
      type: "kbd",
      children: [
        { type: "code", text: "</kbd>" },
        { type: "text", text: "x" },
      ],
    }])
  })
})

function makeLiveView(doc: string) {
  const errors: unknown[] = []
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [
      editorExtensions(),
      EditorView.exceptionSink.of(err => errors.push(err)),
    ],
  })
  const view = new EditorView({ state, parent })
  return {
    view,
    errors,
    destroy() {
      view.destroy()
      parent.remove()
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe("EditorView <kbd> rendering", () => {
  it("renders fixed <kbd> keys without their tag markers", async () => {
    const { view, errors, destroy } = makeLiveView("<kbd>Ctrl</kbd> + <kbd>K</kbd>\n\ntail")
    await tick()
    expect(errors.map(String)).toEqual([])
    const keys = [...view.dom.querySelectorAll(".omd-kbd")].map(el => el.textContent)
    expect(keys).toEqual(["Ctrl", "K"])
    const line = view.dom.querySelector(".cm-line")?.textContent ?? ""
    expect(line).not.toContain("<kbd>")
    expect(line).not.toContain("</kbd>")
    expect(line).toContain("Ctrl + K")
    destroy()
  })

  it("keeps an invalid <kbd> form as visible source", async () => {
    const doc = "<kbd class=\"x\">Ctrl</kbd>\n\ntail"
    const { view, errors, destroy } = makeLiveView(doc)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.dom.querySelector(".omd-kbd")).toBeNull()
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe(doc.split("\n\n")[0])
    destroy()
  })
})

