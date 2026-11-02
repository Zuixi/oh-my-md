import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { editorExtensions } from "../src/index"
import { tableAt } from "../src/tables/navigate"
import { getTableEditSession } from "../src/tables/directEdit"

// Follower 契约（view.test.ts "reopens the landed cell" 钉死主行为）：外来折叠选区
// 落进渲染表时，下一帧开会话并把文档选区停在 table.from。这里的补充断言：
// **落点在格内的偏移必须保留** —— 脚注回跳/goto-line 的意义就是回到原位，
// 落到格首等于白跳（tableCaretFollower 修复的回归）。
const DOC = "before\n\n| h |\n|---|\n| x y |\n\nafter"

function mount(): EditorView {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: 0 },
      extensions: [editorExtensions()],
    }),
    parent,
  })
  return view
}

const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))

async function settledSession(view: EditorView) {
  // 等待渐进装饰与 follower 的 rAF 各自完成。
  for (let i = 0; i < 8 && getTableEditSession(view.state) === null; i++) {
    await frame()
  }
  return getTableEditSession(view.state)
}

describe("tableCaretFollower preserves the foreign caret's cell offset", () => {
  it("opens the session at the landed offset, not the cell start", async () => {
    const view = mount()
    // "x y" 格内偏移 1（"x" 与 " " 之间）：模拟脚注回跳/goto-line 的折叠选区落点。
    const landed = DOC.indexOf("x y") + 1
    view.dispatch({ selection: { anchor: landed } })

    const session = await settledSession(view)
    const table = tableAt(view.state, DOC.indexOf("| h |"))
    expect(session).toBeTruthy()
    expect(view.state.selection.main.head).toBe(table!.from)

    const input = view.dom.querySelector<HTMLInputElement>(".omd-table-cell-input")
    expect(input).toBeTruthy()
    // 格模型值 "x y"（首尾空格已 trim）：落点在 "x" 后 = 偏移 1。
    expect(input!.value).toBe("x y")
    expect(input!.selectionStart).toBe(1)
    view.destroy()
  })

  it("keeps the cell-start fallback when the landed offset is outside the cell text", async () => {
    const view = mount()
    // 落在管道符后（格文本前）的位置：`cellAt` 归入该格，偏移 0。
    const landed = DOC.indexOf("| x y |") + 1
    view.dispatch({ selection: { anchor: landed } })

    const session = await settledSession(view)
    expect(session).toBeTruthy()
    const input = view.dom.querySelector<HTMLInputElement>(".omd-table-cell-input")
    expect(input!.selectionStart).toBe(trimmedStart(input!.value))
    view.destroy()
  })
})

function trimmedStart(value: string): number {
  return value.length - value.trimStart().length
}
