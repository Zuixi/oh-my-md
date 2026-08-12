import { describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"

// View 级冒烟：纯函数 spec 测试测不到 "Block decorations may not be specified
// via plugins" 这类运行时崩溃（M2 事故的盲区），这里实例化真实 EditorView 守门。
function makeView(doc: string, anchor = doc.length) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },   // 默认光标放文末，块处于渲染态
      extensions: [editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
    }),
    parent,
  })
  return { view, errors }
}

const tick = (ms = 100) => new Promise(r => setTimeout(r, ms))

describe("view smoke (real EditorView)", () => {
  it("renders table/code/math blocks without exceptions", async () => {
    const { view, errors } = makeView("| a |\n|---|\n| 1 |\n\n```js\nlet x = 1\n```\n\n$$a$$\n\ntail")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.dom.querySelector(".omd-table table")).toBeTruthy()   // TableWidget 同步渲染
    expect(view.dom.querySelector(".omd-code")).toBeTruthy()          // shiki 异步，容器先行
    expect(view.dom.querySelector(".omd-math")).toBeTruthy()
    view.destroy()
  })

  it("clicking a block widget moves the cursor into the block (source edit)", async () => {
    const { view, errors } = makeView("| a |\n|---|\n| 1 |\n")
    await tick()
    const block = view.dom.querySelector(".omd-block") as HTMLElement
    expect(block).toBeTruthy()
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(view.state.selection.main.head).toBe(1)   // pos 0 + 1
    await tick()
    expect(view.dom.querySelector(".omd-block")).toBeNull()  // widget 已卸载，回到源码
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("typing the closing fence keeps source visible (no premature widget)", async () => {
    const { view, errors } = makeView("```js\nlet x = 1\n``")
    view.dispatch({ changes: { from: 16, insert: "`" } })   // 敲出第三个 backtick，光标在块尾
    await tick()
    expect(view.dom.querySelector(".omd-code")).toBeNull()   // 边界算块内 → 还是源码
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("atomic ranges exclude mark decorations (cursor can enter styled text)", () => {
    const state = EditorState.create({ doc: "[text](http://x.com)", extensions: editorExtensions() })
    const { atomic } = state.field(livePreviewField)
    let covered = false
    atomic.between(0, state.doc.length, (from, to) => { if (from <= 2 && to >= 3) covered = true })
    expect(covered).toBe(false)   // 位置 2 在 "text" 里，只被 mark:omd-link 覆盖，不得原子化
  })
})
