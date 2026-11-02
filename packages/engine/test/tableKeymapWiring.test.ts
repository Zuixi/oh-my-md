import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"

// 装配归属测试：tableKeymap.test.ts 只验证 spec 语义，看不到 tableKeymap 是否真的
// 注册进了 editorExtensions()、是否真的赢下 Tab/Enter。教训同 enter-ownership.test.ts：
// 把 tableKeymap 从数组里删掉、或挪到 codeLineKeymap 之后，纯 spec 套件依然全绿
// （上游 markdown() 自带 Prec.high 的 Enter，同优先级先注册者胜）。
// 这里每个用例只经真实 keymap 链断言结果。

const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

const TABLE = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")
const LAST_ROW_HEAD = TABLE.indexOf("| a | b |") + 2  // 指向末行的 "a" 单元格

function viewWith(doc: string, head: number, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [hostKeys, editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) }), ...extra],
    }),
    parent,
  })
  // 树驱动命令（tableAt / codeContentLine）需要完整树。
  forceParsing(view, view.state.doc.length, 10_000)
  return { view, errors, cleanup: () => { view.destroy(); parent.remove() } }
}

function press(view: EditorView, key: string, shift = false) {
  const event = new KeyboardEvent("keydown", {
    key, shiftKey: shift, bubbles: true, cancelable: true,
  })
  view.contentDOM.dispatchEvent(event)
  return event
}

describe("tableKeymap wins Tab/Enter through editorExtensions()", () => {
  it("moves the caret to the next cell on Tab and leaves the document alone", () => {
    const { view, errors, cleanup } = viewWith(TABLE, TABLE.indexOf("A"))
    const event = press(view, "Tab")
    expect(view.state.doc.toString()).toBe(TABLE)
    expect(view.state.selection.main.head).toBe(TABLE.indexOf("B"))
    expect(event.defaultPrevented).toBe(true)
    expect(errors).toEqual([])
    cleanup()
  })

  it("exits to the blank paragraph on Enter in the last row", () => {
    // 上游 insertNewlineContinueMarkup 在表格里直接 bail（无 list/quote 上下文），
    // host 的 insertNewlineAndIndent 则插入一个裸换行 —— 只有 tableKeymap 会把光标
    // 送到表后的空段。加行是 Tab 的职责，Enter 不得再追加行。
    const { view, errors, cleanup } = viewWith(TABLE, LAST_ROW_HEAD)
    const event = press(view, "Enter")
    expect(view.state.doc.toString()).toBe(TABLE)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("")
    expect(event.defaultPrevented).toBe(true)
    expect(errors).toEqual([])
    cleanup()
  })

  it("still moves down to the same column from a header cell on Enter", () => {
    const { view, errors, cleanup } = viewWith(TABLE, TABLE.indexOf("A"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe(TABLE)
    expect(view.state.selection.main.head).toBe(TABLE.indexOf("a |"))
    expect(errors).toEqual([])
    cleanup()
  })

  it("still indents a fenced-code content line on Tab (the table keymap does not steal it)", () => {
    const doc = "```js\nconst a = 1\n```"
    const { view, errors, cleanup } = viewWith(doc, doc.indexOf("a = 1"))
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("```js\n  const a = 1\n```")
    expect(errors).toEqual([])
    cleanup()
  })
})

describe("tableKeymap rejects read-only documents through the real keymap chain", () => {
  it("Enter inside a table row changes nothing and the handler falls through", () => {
    // tableNextRowSpec 在末行会退出表格（可能改写文档），exitTableSpec 永远改写 ——
    // readOnly 守卫只在 tableKeymap.ts 的 dispatchSpec 里，因此必须挂载真实视图验证。
    const { view, errors, cleanup } = viewWith(TABLE, LAST_ROW_HEAD, [EditorState.readOnly.of(true)])
    const event = press(view, "Enter")
    expect(view.state.doc.toString()).toBe(TABLE)
    expect(view.state.selection.main.head).toBe(LAST_ROW_HEAD)
    // 未被消费 → 落到上游/host 命令，而它们各自也拒绝只读，且不抛异常。
    expect(event.defaultPrevented).toBe(false)
    expect(errors).toEqual([])
    cleanup()
  })
})
