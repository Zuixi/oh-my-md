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
    // 头部 widget block 替换开头围栏文字（不含换行）——行内替换会残留正文
    // 行高 strut 在头部与首行之间漏出无背景空带；含换行会吞掉首行行装饰
    const chrome = specs.find(s => s.tag === "widget:block:code-chrome")
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
    expect(specs.find(s => s.tag === "widget:block:code-chrome")).toBeUndefined()
  })

  // 未闭合围栏（如删除了尾 ```）：内容延伸到文档末尾，不得把最后一行当
  // 尾围栏折叠吞掉 —— 尾围栏必须由真实闭合 CodeMark 定位。
  it("unterminated fence numbers every content line and never collapses the last line", () => {
    const doc = "```cpp\nint a\nint b"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.indexOf("int a") + 2 } }).state
    const specs = collectDecorationSpecs(state, 0, doc.length)
    expect(specs.find(s => s.tag === "widget:block:code-chrome")).toBeTruthy()
    expect(specs.filter(s => s.tag === "line:omd-codeblock-num").length).toBe(2)
    expect(specs.find(s => s.tag === "replace:CloseFence")).toBeUndefined()
    expect(specs.some(s => s.tag === "line:omd-codeblock-num-last" && s.from === doc.indexOf("int b"))).toBe(true)
  })

  it("unterminated fence keeps the caret line visible when it is the last line", () => {
    const doc = "```cpp\nint a\nint b"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.indexOf("int b") + 2 } }).state
    const specs = collectDecorationSpecs(state, 0, doc.length)
    expect(specs.some(s => s.tag === "line:omd-codeblock-num" && s.from === doc.indexOf("int b"))).toBe(true)
    expect(specs.find(s => s.tag === "replace:CloseFence")).toBeUndefined()
  })

  it("mermaid editing state stays plain (no code chrome)", () => {
    const mdoc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n\ntail"
    let state = makeState(mdoc)
    state = state.update({ selection: { anchor: mdoc.indexOf("graph") + 2 } }).state
    const specs = collectDecorationSpecs(state, 0, mdoc.length)
    expect(specs.find(s => s.tag === "widget:block:code-chrome")).toBeUndefined()
    expect(specs.find(s => s.tag === "replace:CloseFence")).toBeUndefined()
  })
})

import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { editorExtensions } from "../src/index"
import { continueFence } from "../src/format/fences"

describe("editing-state code chrome (view)", () => {
  // 用户主流程：文档中间输入 ```cpp 回车 → 立即落在渲染好的编辑态代码块内。
  it("Enter on a mid-document ```lang line completes the fence into the rendered editing state", async () => {
    const doc = "intro\n\n```cpp\n\noutro text"
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("```cpp") + 6 },
        extensions: [editorExtensions(), EditorView.exceptionSink.of(() => {})],
      }),
      parent,
    })
    try {
      expect(continueFence(view)).toBe(true)
      await new Promise(r => setTimeout(r, 100))
      // 块已成形：chrome 头部在场、围栏文本不可见、光标在首个内容行
      expect(view.dom.querySelector(".omd-code-header")).toBeTruthy()
      expect(view.dom.querySelector(".cm-line.omd-codeblock-num")).toBeTruthy()
      expect(view.dom.textContent).not.toContain("```")
      expect(view.state.selection.main.head).toBe(doc.indexOf("```cpp") + 7)
      // 下方文字保留在块后
      expect(view.state.doc.toString()).toBe("intro\n\n```cpp\n\n```\n\noutro text")
      expect(view.dom.textContent).toContain("outro text")
    } finally {
      view.destroy()
      parent.remove()
    }
  })

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
      // 头部 block 替换不得吞掉首个内容行的行号/容器类（“断档”回归的另一面）
      expect(view.dom.querySelector(".cm-line.omd-codeblock-num")).toBeTruthy()
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
