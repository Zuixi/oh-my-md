import { describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState, type Extension } from "@codemirror/state"
import { history, undo } from "@codemirror/commands"
import { editorExtensions } from "../src/index"

// 与 test/view.test.ts 同款：真实 EditorView 组装。额外扩展（readOnly / history）可注入。
function makeView(doc: string, anchor = doc.length, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },   // 光标在块外 → 块处于渲染态
      extensions: [editorExtensions(), ...extra, EditorView.exceptionSink.of(e => { errors.push(e) })],
    }),
    parent,
  })
  return { view, errors }
}

const tick = (ms = 100) => new Promise(r => setTimeout(r, ms))

async function waitFor(selector: string, view: EditorView, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const match = view.dom.querySelector(selector)
    if (match) return match
    await tick(20)
  }
  return null
}

function clickBlock(view: EditorView) {
  const block = view.dom.querySelector(".omd-math") as HTMLElement
  expect(block).toBeTruthy()
  block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  return block
}

const DOC = "$$\nx+y\n$$\n\ntail"

describe("math block popup editor", () => {
  it("opens a popup with the block TeX prefilled on click", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const ta = await waitFor(".omd-math-popup .omd-math-editor", view) as HTMLTextAreaElement
    expect(ta).toBeTruthy()
    expect(ta.value).toBe("x+y")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("typing writes through to the document and keeps the same widget and popup DOM", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    const block = clickBlock(view)
    const ta = view.dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")!
    const popup = ta.closest(".omd-math-popup") as HTMLElement
    expect(ta).toBeTruthy()

    ta.value = "x+z"
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    await tick()
    // 第二次输入必须读文档现值：wrap 监听器属于创建时的旧实例，其 this.src 已过期
    ta.value = "x+z+w"
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    await tick()

    expect(view.state.doc.toString()).toContain("$$\nx+z+w\n$$")
    expect(view.dom.querySelector(".omd-math")).toBe(block)          // 身份稳定：同一节点
    expect(view.dom.querySelector(".omd-math-popup")).toBe(popup)
    expect(view.dom.querySelector(".omd-math-editor")).toBe(ta)
    const content = view.dom.querySelector(".cm-content") as HTMLElement
    expect(content.textContent).not.toContain("$$")   // 编辑期不露原始围栏源码
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("removes the popup on Escape", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const ta = await waitFor(".omd-math-editor", view) as HTMLTextAreaElement
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(view.dom.querySelector(".omd-math-popup")).toBeNull()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("does not open a popup in a read-only view", async () => {
    const { view, errors } = makeView(DOC, DOC.length, [EditorState.readOnly.of(true)])
    await tick()
    const block = view.dom.querySelector(".omd-math") as HTMLElement
    expect(block).toBeTruthy()
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    await tick()
    expect(view.dom.querySelector(".omd-math-popup")).toBeNull()
    expect(view.dom.querySelector(".omd-math-editor")).toBeNull()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("undo restores the previous tex and keeps the widget mounted", async () => {
    const { view, errors } = makeView(DOC, DOC.length, [history()])
    await tick()
    clickBlock(view)
    const ta = view.dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")!
    ta.value = "x+y+z"
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    await tick()
    expect(view.state.doc.toString()).toContain("$$\nx+y+z\n$$")

    undo(view)
    await tick()
    expect(view.state.doc.toString()).toContain("$$\nx+y\n$$")
    expect(view.dom.querySelector(".omd-math")).toBeTruthy()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })
})
