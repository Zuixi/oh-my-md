import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { clampToContentStart, lineContentStart } from "../src/format/blockPrefix"

const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

function viewWith(doc: string, head: number, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [hostKeys, editorExtensions(), ...extra],
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  return view
}

function press(view: EditorView, key: string, shift = false) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key, shiftKey: shift, bubbles: true, cancelable: true,
  }))
}

const head = (view: EditorView) => view.state.selection.main.head
const anchor = (view: EditorView) => view.state.selection.main.anchor

describe("content start of a line block prefix", () => {
  const start = (doc: string, pos: number) => {
    const state = makeState(doc).update({ selection: { anchor: pos } }).state
    return lineContentStart(state, state.doc.lineAt(pos))
  }

  it("skips indent + every marker + exactly one following space", () => {
    expect(start("> abc", 3)).toBe(2)
    expect(start(">abc", 3)).toBe(1)
    expect(start("  > abc", 5)).toBe(4)
    expect(start("> > ab", 5)).toBe(4)
    expect(start("> - [ ] x", 5)).toBe(8)
    expect(start("> 1. item", 5)).toBe(5)
  })

  it("treats a marker-less line as content from its start", () => {
    // 代码块里的行首缩进是内容，不是前缀（否则 Tab 会改到缩进之外）。
    expect(start("  code", 4)).toBe(0)
    expect(start("plain", 3)).toBe(0)
  })

  it("clamps only positions inside the prefix", () => {
    const state = makeState("> abc")
    expect(clampToContentStart(state, 0)).toBe(2)
    expect(clampToContentStart(state, 1)).toBe(2)
    expect(clampToContentStart(state, 2)).toBe(2)
    expect(clampToContentStart(state, 4)).toBe(4)
  })
})

describe("caret clamp keymap", () => {
  it("moves Home to the content start instead of inside the quote marker", () => {
    const view = viewWith("> abc", 5)
    press(view, "Home")
    expect(head(view)).toBe(2)
    expect(view.state.doc.toString()).toBe("> abc")
    view.destroy()
  })

  it("keeps the anchor when extending with Shift-Home", () => {
    const view = viewWith("> abc", 5)
    press(view, "Home", true)
    expect(anchor(view)).toBe(5)
    expect(head(view)).toBe(2)
    expect(view.state.sliceDoc(2, 5)).toBe("abc")
    view.destroy()
  })

  it("leaves lines without a prefix to the host Home binding", () => {
    const view = viewWith("plain text", 6)
    press(view, "Home")
    expect(head(view)).toBe(0)
    view.destroy()
  })

  it("is idempotent at the content start", () => {
    const view = viewWith("> abc", 2)
    press(view, "Home")
    expect(head(view)).toBe(2)
    view.destroy()
  })
})
