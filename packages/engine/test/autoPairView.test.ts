import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing } from "@codemirror/language"
import { EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { editorExtensions, setAutoPair } from "../src/index"

// 真实 EditorView（happy-dom）下的适配层验证：inputHandler 一旦返回 true，@codemirror/view
// 就 preventDefault，未覆盖的 range 一个字符都收不到（D10）。纯 spec 测不到这一层，
// 这里走 view 的 inputHandler facet 与真实 keymap 链。hostKeys 先于 editorExtensions 注册，
// 与 apps/desktop/src/Editor.ts 的顺序一致 —— Backspace 必须靠 Prec.high 才能赢。

const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

function mount(doc: string, selection?: EditorSelection, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      ...(selection ? { selection } : {}),
      extensions: [hostKeys, editorExtensions(), ...extra],
    }),
    parent,
  })
  // 树驱动判定需要完整树（与 enter-ownership.test.ts 同款）。
  forceParsing(view, view.state.doc.length, 10_000)
  return { view, cleanup: () => { view.destroy(); parent.remove() } }
}

/**
 * 引擎在 editorExtensions 里注册的 inputHandler **不是 facet[0]**：`markdownCodeLanguages()`
 * 带来的 @codemirror/lang-html `autoCloseTags` 先注册。facet 本身是无 combine 的数组，
 * @codemirror/view 的 applyDOMChangeInner 用 `.some(...)` 依次询问（第一个返回 true 的赢），
 * 所以这里照抄那条链路，而不是假设下标。
 */
function input(view: EditorView, from: number, to: number, text: string, insert: () => Transaction): boolean {
  return view.state.facet(EditorView.inputHandler).some(h => h(view, from, to, text, insert))
}

/** CM 的默认管线回调：只有 handler 返回 false 才会被调用。 */
function noInsert(): Transaction {
  throw new Error("the default insert callback must not be called")
}

function press(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

describe("auto pair input handler wiring", () => {
  it("pairs through the facet registered by editorExtensions", () => {
    const { view, cleanup } = mount("")
    const main = view.state.selection.main
    expect(input(view, main.from, main.to, "(", noInsert)).toBe(true)
    expect(view.state.doc.toString()).toBe("()")
    expect(view.state.selection.main.head).toBe(1)
    cleanup()
  })

  it("pairs at every cursor in one transaction (D10)", () => {
    // CM6 会把多选区折叠成 asSingle()，除非宿主开启 allowMultipleSelections；
    // 这条用例要验证的是配对适配层覆盖全部 range，所以显式打开该 facet。
    const { view, cleanup } = mount(
      "ab\ncd",
      EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)], 1),
      [EditorState.allowMultipleSelections.of(true)],
    )
    expect(view.state.selection.ranges.length).toBe(2)
    const main = view.state.selection.main
    expect(main.head).toBe(5)
    expect(input(view, main.from, main.to, "(", noInsert)).toBe(true)
    expect(view.state.doc.toString()).toBe("ab()\ncd()")
    expect(view.state.selection.ranges.map(r => r.head)).toEqual([3, 8])
    cleanup()
  })

  // R1/验收 §6.3：放弃路径必须是「没有发生任何事」，而不是「一处配对」。
  it("bails out without any side effect when one cursor is suppressed (D10/R1)", () => {
    const { view, cleanup } = mount(
      "foo\n\nbar",
      EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(8)], 1),
      [EditorState.allowMultipleSelections.of(true)],
    )
    expect(view.state.selection.ranges.length).toBe(2)
    const before = view.state
    let insertCalls = 0
    const insert = () => { insertCalls++; return undefined as never }
    const main = view.state.selection.main
    expect(input(view, main.from, main.to, "*", insert)).toBe(false)
    expect(view.state).toBe(before)  // 引用恒等：没有任何局部 dispatch
    expect(insertCalls).toBe(0)
    // 退回默认管线后，所有光标各拿到一个裸字符（记录 CM 的默认行为）。
    view.dispatch(view.state.replaceSelection("*"))
    expect(view.state.doc.toString()).toBe("foo\n*\nbar*")
    expect(view.state.selection.ranges.map(r => r.head)).toEqual([5, 10])
    cleanup()
  })

  // 验收 §6.4 / D12：代码块里的标记是普通字符，不能被跳越吞掉。
  it("inserts instead of skipping a marker inside a fenced code block (D12)", () => {
    const doc = "```\n`x`\n```"
    const { view, cleanup } = mount(doc, EditorSelection.single(6))
    expect(input(view, 6, 6, "`", noInsert)).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
    view.dispatch(view.state.replaceSelection("`"))
    expect(view.state.doc.length).toBe(doc.length + 1)
    cleanup()
  })

  it("keeps typing plain while an IME composition is active", () => {
    const { view, cleanup } = mount("")
    // compositionstart 把 inputState.composing 置 0：view.compositionStarted 为真
    // （view.composing 只在 >0 时为真，两者都在 handler 的守卫里）。
    view.contentDOM.dispatchEvent(new Event("compositionstart", { bubbles: true }))
    expect(view.compositionStarted).toBe(true)
    const main = view.state.selection.main
    expect(input(view, main.from, main.to, "(", noInsert)).toBe(false)
    expect(view.state.doc.toString()).toBe("")
    cleanup()
  })

  it("hot-swaps the three toggles through setAutoPair", () => {
    const { view, cleanup } = mount("")
    view.dispatch({ effects: setAutoPair({ brackets: false, quotes: true, markdownSyntax: true }) })
    const main = view.state.selection.main
    expect(input(view, main.from, main.to, "(", noInsert)).toBe(false)
    expect(view.state.doc.toString()).toBe("")
    const after = view.state.selection.main
    expect(input(view, after.from, after.to, '"', noInsert)).toBe(true)
    expect(view.state.doc.toString()).toBe('""')
    cleanup()
  })
})

describe("auto pair Backspace through the real keymap chain", () => {
  it("deletes both halves of a pair in one keystroke", () => {
    const { view, cleanup } = mount("()", EditorSelection.single(1))
    press(view, "Backspace")
    expect(view.state.doc.toString()).toBe("")
    cleanup()
  })

  it("yields the key when it is not between a pair", () => {
    const { view, cleanup } = mount("ab", EditorSelection.single(2))
    press(view, "Backspace")
    expect(view.state.doc.toString()).toBe("a")
    cleanup()
  })

  it("leaves a readonly document untouched", () => {
    const { view, cleanup } = mount("()", EditorSelection.single(1), [EditorState.readOnly.of(true)])
    press(view, "Backspace")
    expect(view.state.doc.toString()).toBe("()")
    cleanup()
  })
})
