import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const doc = "intro\n\n```js hi\nlet x = 1\nconst s = \"a\"\n```\n\ntail"
const CARET = doc.indexOf("let x") + 2

const specsAt = (caret: number) => {
  let state = makeState(doc)
  state = state.update({ selection: { anchor: caret } }).state
  return collectDecorationSpecs(state, 0, state.doc.length)
}

describe("editing-state code chrome (fence-line widget)", () => {
  it("caret inside renders the chrome widget over the opening fence and collapses the closing fence", () => {
    const specs = specsAt(CARET)
    const tags = specs.map(s => s.tag)
    // 头部 widget 替换开头围栏行内容
    const chrome = specs.find(s => s.tag === "widget:code-chrome")
    expect(chrome).toBeTruthy()
    expect(chrome!.from).toBe(doc.indexOf("```js"))
    expect(chrome!.to).toBe(doc.indexOf("```js") + "```js hi".length)
    // 尾围栏行折叠（含换行，Setext 式块替换）
    const close = specs.find(s => s.tag === "replace:CloseFence")
    expect(close).toBeTruthy()
    expect(close!.from).toBe(doc.lastIndexOf("```"))
    // 内容行行号类
    expect(specs.filter(s => s.tag === "line:omd-codeblock-num").length).toBe(2)
    expect(specs.filter(s => s.tag === "line:omd-codeblock-num-first").length).toBe(1)
    expect(specs.filter(s => s.tag === "line:omd-codeblock-num-last").length).toBe(1)
    // 原有灰底类保留（cm-activeLine 联动依赖它）
    expect(tags).toContain("line:omd-codeblock")
  })

  it("caret on the closing fence line keeps it visible (no collapse)", () => {
    const specs = specsAt(doc.lastIndexOf("```") + 1)
    expect(specs.find(s => s.tag === "replace:CloseFence")).toBeUndefined()
  })

  it("caret on the opening fence line shows the raw fence instead of chrome", () => {
    const specs = specsAt(doc.indexOf("```js") + 2)
    expect(specs.find(s => s.tag === "widget:code-chrome")).toBeUndefined()
  })

  it("mermaid editing state stays plain (no code chrome)", () => {
    const mdoc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n\ntail"
    let state = makeState(mdoc)
    state = state.update({ selection: { anchor: mdoc.indexOf("graph") + 2 } }).state
    const specs = collectDecorationSpecs(state, 0, mdoc.length)
    expect(specs.find(s => s.tag === "widget:code-chrome")).toBeUndefined()
    expect(specs.find(s => s.tag === "replace:CloseFence")).toBeUndefined()
  })
})

import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { editorExtensions } from "../src/index"

describe("editing-state code chrome (view)", () => {
  it("keeps the chrome mounted while typing and commits fence info from it", async () => {
    const doc = "intro\n\n```js hi\nlet x = 1\n```\n\ntail"
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("let x") + 2 },
        extensions: [editorExtensions(), EditorView.exceptionSink.of(() => {})],
      }),
      parent,
    })
    try {
      await new Promise(r => setTimeout(r, 100))
      const header = view.dom.querySelector(".omd-code-header") as HTMLElement
      expect(header).toBeTruthy()
      expect(view.dom.querySelector(".omd-code-title")).toBeTruthy()
      // 围栏标记不可见（开头被 chrome 替换、结尾被折叠）
      expect(view.dom.textContent).not.toContain("```")

      // 编辑内容行：chrome DOM 复用不重建（eq 按 lang/title）
      view.dispatch({ changes: { from: doc.indexOf("let") + 3, insert: "y" } })
      await new Promise(r => setTimeout(r, 100))
      expect(view.dom.querySelector(".omd-code-header")).toBe(header)
      expect(view.dom.textContent).not.toContain("```")

      // 标题提交走当前 FencedCode 范围（posAtDOM 反查）
      const input = header.querySelector(".omd-code-title") as HTMLInputElement
      input.value = "renamed"
      input.dispatchEvent(new Event("change"))
      await new Promise(r => setTimeout(r, 100))
      expect(view.state.doc.toString()).toContain("```js renamed")
      expect(view.dom.querySelector(".omd-code-header")).toBeTruthy()
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})
