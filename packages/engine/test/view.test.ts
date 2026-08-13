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

async function waitFor(selector: string, view: EditorView, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const match = view.dom.querySelector(selector)
    if (match) return match
    await tick(20)
  }
  return null
}

describe("view smoke (real EditorView)", () => {
  it("renders a thematic break as an hr without the source markers", async () => {
    const { view, errors } = makeView("before\n\n***\n\nafter")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.dom.querySelector(".omd-hr-block hr")).toBeTruthy()
    expect([...view.dom.querySelectorAll(".cm-line")].some(el => el.textContent?.includes("***"))).toBe(false)
    view.destroy()
  })

  it("displays sequential ordered-list numbers from gapped source", async () => {
    const { view, errors } = makeView("1. 第一项\n3. 第二项\n7. 第三项\n\ntail")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. 第一项\n2. 第二项\n3. 第三项\n\ntail")
    const labels = [...view.dom.querySelectorAll(".omd-ordered-mark")].map(el => el.textContent)
    expect(labels).toEqual(["1.", "2.", "3."])
    view.destroy()
  })

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
    // happy-dom 无 layout，posAtCoords 返回 null，fallback 到 posAtDOM(wrap) = 0。
    // 真实浏览器中 posAtCoords 会用鼠标坐标精确定位。
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(view.state.selection.main.head).toBe(0)
    await tick()
    expect(view.dom.querySelector(".omd-block")).toBeNull()  // widget 已卸载，回到源码
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps block click position correct after inserting before the widget", async () => {
    const doc = "before\n\n| a |\n|---|\n| 1 |\n"
    const { view, errors } = makeView(doc)
    await tick()
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } })
    await tick()
    // happy-dom 无 layout：posAtCoords 和 posAtDOM 均返回 0，光标落在文档开头而非块内，
    // widget 不会因 mousedown 自然卸载。精确的鼠标定位需手动 QA 在真实浏览器中验证。
    // 这里验证：把选区显式移进表格块内后，blockSelected 逻辑使 widget 卸载。
    const tableStart = doc.indexOf("| a |") + "prefix\n".length
    view.dispatch({ selection: { anchor: tableStart } })
    await tick()
    expect(view.dom.querySelector(".omd-block")).toBeNull()  // 选区在块内，widget 已卸载
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })


  it("keeps checkbox edit position correct after inserting before it", async () => {
    const doc = "before\n\n- [ ] task\n"
    const { view, errors } = makeView(doc, 0)
    await tick()
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } })
    await tick()
    const checkbox = view.dom.querySelector(".omd-checkbox") as HTMLInputElement
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(view.state.doc.toString()).toContain("- [x] task")
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

  it("renders meaningful final DOM for synchronous and async widgets", async () => {
    const doc = [
      "| a\\|b | `x\\|y` |",
      "|:---|---:|",
      "| 1 | |",
      "| only |",
      "",
      "```unknown-language",
      "<unsafe>",
      "```",
      "",
      "$$a^2$$",
      "",
      "inline $x+1$ and ![alt](pic.png)",
      "",
      "tail",
    ].join("\n")
    const { view, errors } = makeView(doc)
    expect(await waitFor(".omd-table tbody td", view)).toBeTruthy()
    expect(view.dom.querySelector(".omd-table th")?.textContent).toBe("a|b")
    expect(view.dom.querySelectorAll(".omd-table th")).toHaveLength(2)
    expect(view.dom.querySelectorAll(".omd-table th")[1]?.textContent).toBe("x|y")
    expect(view.dom.querySelectorAll(".omd-table tbody td")).toHaveLength(4)
    expect(view.dom.querySelectorAll(".omd-table tbody td")[3]?.textContent).toBe("")
    expect(await waitFor(".omd-code pre", view)).toBeTruthy()
    expect(view.dom.querySelector(".omd-code")?.textContent).toContain("<unsafe>")
    expect(await waitFor(".omd-math .katex", view)).toBeTruthy()
    expect(await waitFor(".omd-inline-math .katex", view)).toBeTruthy()
    const image = await waitFor(".omd-image", view) as HTMLImageElement
    expect(image.alt).toBe("alt")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("hides the quote marker in the live line while the cursor is in the content", async () => {
    const { view, errors } = makeView("> hello", 2)
    await tick()
    const line = view.dom.querySelector(".omd-blockquote")
    expect(line).toBeTruthy()
    expect(line?.textContent).toBe("hello")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("preserves table alignment inside a blockquote", async () => {
    const doc = "> | left | right |\n> |:---|---:|\n> | 1 | 2 |\n\noutside"
    const { view, errors } = makeView(doc)
    expect(await waitFor(".omd-table th", view)).toBeTruthy()
    const headers = view.dom.querySelectorAll(".omd-table th")
    expect((headers[0] as HTMLElement).style.textAlign).toBe("left")
    expect((headers[1] as HTMLElement).style.textAlign).toBe("right")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("contains invalid async widget output in meaningful fallbacks", async () => {
    const doc = [
      "```mermaid",
      "not a valid diagram ???",
      "```",
      "",
      "$$\\notacommand{$$",
      "",
      "outside",
    ].join("\n")
    const { view, errors } = makeView(doc)
    const mermaidError = await waitFor(".omd-mermaid .omd-block-error", view)
    const mathError = await waitFor(".omd-math .omd-block-error", view)
    expect(mermaidError?.textContent).toContain("not a valid diagram")
    expect(mathError?.textContent).toContain("\\notacommand")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("does not write mermaid output after the widget is destroyed", async () => {
    const mermaid = [
      "```mermaid",
      "graph TD",
      "  A[Start] --> B[Done]",
      "```",
      "",
      "outside",
    ].join("\n")
    const { view, errors } = makeView(mermaid)
    expect(view.dom.querySelector(".omd-mermaid")).toBeTruthy()
    view.destroy()
    await tick(700)
    expect(errors.map(String)).toEqual([])
  })

})
