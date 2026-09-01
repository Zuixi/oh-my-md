import { describe, expect, it, vi } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState, type Extension } from "@codemirror/state"
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language"
import { history, undo } from "@codemirror/commands"
import type { SyntaxNode } from "@lezer/common"
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

async function waitForTex(view: EditorView, tex: string, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const ann = view.dom.querySelector(".omd-math .omd-block-body annotation")
    if (ann && ann.textContent === tex) return ann
    await tick(20)
  }
  return null
}

function clickBlock(view: EditorView) {
  const block = view.dom.querySelector(".omd-math") as HTMLElement
  expect(block).toBeTruthy()
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })
  block.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  return block
}

/** 弹窗内嵌编辑器：从 popup 的 cm-content 反查它的 EditorView 实例。 */
function innerViewOf(outer: EditorView) {
  const content = outer.dom.querySelector(".omd-math-popup .cm-content") as HTMLElement
  expect(content).toBeTruthy()
  const inner = EditorView.findFromDOM(content)
  expect(inner).toBeTruthy()
  return inner!
}

function contentOf(outer: EditorView) {
  return outer.dom.querySelector(".omd-math-popup .cm-content") as HTMLElement
}

/** 模拟整段替换式输入（等价于旧 textarea 测试里的 ta.value = …; input 事件）。 */
function setTex(inner: EditorView, tex: string) {
  inner.dispatch({ changes: { from: 0, to: inner.state.doc.length, insert: tex } })
}

const DOC = "$$\nx+y\n$$\n\ntail"

describe("math block popup editor", () => {
  it("opens a popup with a focused CodeMirror editor prefilled with the block TeX on click", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const popup = await waitFor(".omd-math-popup", view) as HTMLElement
    expect(popup.querySelector(".cm-editor")).toBeTruthy()
    const inner = innerViewOf(view)
    expect(inner.state.doc.toString()).toBe("x+y")
    expect(document.activeElement).toBe(contentOf(view))
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("leaves editor mousedown to the inner CodeMirror so it can place the caret", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const content = contentOf(view)
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })

    content.dispatchEvent(event)

    // CM6 的 mousedown 处理器会自行 preventDefault 并用 posAtCoords 放置光标
    // （这是所有 CM 编辑器的标准行为）；要守护的是 wrap 层不抢事件：
    // 弹窗不关、焦点留在内层编辑器、外层无异常。
    expect(view.dom.querySelector(".omd-math-popup")).toBeTruthy()
    expect(document.activeElement).toBe(content)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("refocuses the same popup when its rendered preview is clicked again", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const popup = view.dom.querySelector<HTMLElement>(".omd-math-popup")!
    const focusTarget = document.createElement("button")
    popup.appendChild(focusTarget)
    focusTarget.focus()
    expect(document.activeElement).toBe(focusTarget)
    expect(view.dom.querySelector(".omd-math-popup")).toBe(popup)

    const preview = view.dom.querySelector<HTMLElement>(".omd-math .omd-block-body")!
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    preview.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(view.dom.querySelector(".omd-math-popup")).toBe(popup)
    expect(document.activeElement).toBe(contentOf(view))
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("typing writes through to the document and keeps the same widget and popup DOM", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    const block = clickBlock(view)
    const inner = innerViewOf(view)
    const popup = view.dom.querySelector(".omd-math-popup") as HTMLElement
    const host = view.dom.querySelector(".omd-math-editor") as HTMLElement
    expect(host).toBeTruthy()

    setTex(inner, "x+z")
    await tick()
    // 第二次输入必须读文档现值：弹窗监听器属于创建时的旧实例，其 this.src 已过期
    setTex(inner, "x+z+w")
    await tick()

    expect(view.state.doc.toString()).toContain("$$\nx+z+w\n$$")
    expect(view.dom.querySelector(".omd-math")).toBe(block)          // 身份稳定：同一节点
    expect(view.dom.querySelector(".omd-math-popup")).toBe(popup)
    expect(view.dom.querySelector(".omd-math-editor")).toBe(host)
    const content = view.dom.querySelector(".cm-content") as HTMLElement
    expect(content.textContent).not.toContain("$$")   // 编辑期不露原始围栏源码（外层内容）
    expect(contentOf(view).textContent).not.toContain("$$")          // 内层同样只有纯 TeX
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("three length-changing keystrokes in a row never corrupt the document", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    // 回写后重建使 eq 比较 src 漂移，旧实例的 this.pos/this.src 已失效：
    // 每次都必须从实时文档解析块范围，否则第二次起会替换错区间。
    for (const tex of ["x+yz", "x+yzw", "x+yzwv"]) {
      setTex(inner, tex)
      await tick()
      expect(view.state.doc.toString()).toBe(`$$\n${tex}\n$$\n\ntail`)
    }
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("typing re-renders the KaTeX preview inside the same widget DOM", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    const block = clickBlock(view)
    expect(await waitForTex(view, "x+y")).toBeTruthy()   // 首次挂载的渲染
    const inner = innerViewOf(view)
    const body = block.querySelector(".omd-block-body") as HTMLElement
    const first = body.innerHTML

    setTex(inner, "x+z")
    // 预览必须随回写更新：eq 比较 src，pass 1 走 updateDOM 原地重渲
    expect(await waitForTex(view, "x+z")).toBeTruthy()
    expect(view.dom.querySelector(".omd-math")).toBe(block)   // 仍是同一节点
    expect(body.innerHTML).not.toBe(first)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("removes the popup on Escape", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const content = await waitFor(".omd-math-popup .cm-content", view) as HTMLElement
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
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
    const inner = innerViewOf(view)
    setTex(inner, "x+y+z")
    await tick()
    expect(view.state.doc.toString()).toContain("$$\nx+y+z\n$$")

    undo(view)
    await tick()
    expect(view.state.doc.toString()).toContain("$$\nx+y\n$$")
    // Undo 是外部改动：updateDOM 必须把内层编辑器同步回文档现值
    expect(innerViewOf(view).state.doc.toString()).toBe("x+y")
    expect(view.dom.querySelector(".omd-math")).toBeTruthy()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("undo inside the popup writes back to the document", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    setTex(inner, "x+y+z")
    await tick()
    expect(view.state.doc.toString()).toContain("$$\nx+y+z\n$$")

    // CM6 按平台把 Mod 解释为 Cmd/Ctrl：真实 macOS webview 的 platform 含 "Mac"，
    // 而 happy-dom 报 "X11; Darwin arm64"（不含 "Mac"）→ 测试环境里 Mod-z 是 Ctrl-z。
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    inner.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ...mod, bubbles: true }))

    expect(inner.state.doc.toString()).toBe("x+y")                    // 内层回到上一步
    expect(view.state.doc.toString()).toContain("$$\nx+y\n$$")        // 并写回外层文档
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("destroys the inner editor exactly once when closing on Escape", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    const destroySpy = vi.spyOn(inner, "destroy")

    inner.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()

    expect(view.dom.querySelector(".omd-math-popup")).toBeNull()
    expect(destroySpy).toHaveBeenCalledTimes(1)   // remove 引发的 focusout 不得二次销毁
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("destroys the inner editor when the widget itself is discarded", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    const destroySpy = vi.spyOn(inner, "destroy")

    view.dispatch({ selection: { anchor: 2 } })   // 光标进块 → widget 卸载
    await tick()

    expect(view.dom.querySelector(".omd-math-popup")).toBeNull()
    expect(destroySpy).toHaveBeenCalled()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("external document changes re-sync the inner editor without moving the caret", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    inner.dispatch({ selection: { anchor: 1 } })   // 光标放到 TeX 中间

    view.dispatch({ changes: { from: 3, to: 6, insert: "x+y+q" } })   // 外部改块源码
    await tick()

    const synced = innerViewOf(view)
    expect(synced.state.doc.toString()).toBe("x+y+q")
    expect(synced.state.selection.main.anchor).toBe(1)   // 光标原位（夹取到新长度内）
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("skips the inner re-sync while an IME composition is active", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    inner.dispatch({ selection: { anchor: inner.state.doc.length } })

    // 组词：compositionstart 置潜伏态（composing=0），随后的 DOM 文本变化 + input
    // 事件被 CM 读回后 composing>0（这才是 view.composing 为 true 的真实路径）。
    inner.contentDOM.dispatchEvent(new Event("compositionstart", { bubbles: true }))
    inner.contentDOM.querySelector(".cm-line")!.appendChild(document.createTextNode("ni"))
    inner.contentDOM.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "ni" }))
    await tick()
    expect(inner.composing).toBe(true)   // 前置：确认 CM 处于组词态
    expect(inner.state.doc.toString()).toContain("ni")

    // 外部整块替换（块范围从实时语法树解析，避开组词写回造成的偏移漂移）
    let node: SyntaxNode | null = syntaxTree(view.state).resolve(2, 1)
    while (node && node.name !== "MathBlock") node = node.parent
    expect(node?.name).toBe("MathBlock")
    view.dispatch({
      changes: { from: node!.from, to: node!.to, insert: "$$\nx+y+q\n$$" },
    })
    await tick()

    expect(innerViewOf(view).state.doc.toString()).toContain("ni")   // 组词内容未被同步冲掉
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("Tab inserts spaces instead of blurring the popup closed", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    inner.dispatch({ selection: { anchor: 0 } })

    inner.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    await tick()

    expect(inner.state.doc.toString()).toBe("  x+y")
    expect(view.dom.querySelector(".omd-math-popup")).toBeTruthy()   // 未走焦点导航被关
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("highlights LaTeX source with the stex stream language", async () => {
    const { view, errors } = makeView(DOC)
    await tick()
    clickBlock(view)
    const inner = innerViewOf(view)
    setTex(inner, "\\frac{a}{b} % note")
    const tree = ensureSyntaxTree(inner.state, inner.state.doc.length)
    expect(tree).toBeTruthy()
    const names: string[] = []
    tree!.iterate({ enter: node => { names.push(node.name) } })
    expect(names.some(n => /tag/i.test(n))).toBe(true)        // \frac → tagName
    expect(names.some(n => /comment/i.test(n))).toBe(true)    // % 注释
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })
})
