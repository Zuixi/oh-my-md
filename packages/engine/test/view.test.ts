import { describe, expect, it, vi } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import {
  editorExtensions,
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
} from "../src/index"
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

async function openTableBodyCell(view: EditorView, index: number) {
  const table = await waitFor(".omd-table", view)
  expect(table).toBeTruthy()
  const cell = table!.querySelectorAll("tbody td")[index] as HTMLElement | undefined
  expect(cell).toBeTruthy()
  cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
  const input = cell!.querySelector("input.omd-table-edit") as HTMLInputElement | null
  expect(input).toBeTruthy()
  return input!
}

async function waitForTableEdit(view: EditorView, bodyCellIndex: number) {
  const started = Date.now()
  while (Date.now() - started < 3000) {
    const inputs = view.dom.querySelectorAll("input.omd-table-edit")
    const cell = view.dom.querySelectorAll(".omd-table tbody td")[bodyCellIndex]
    if (inputs.length === 1 && cell?.querySelector("input.omd-table-edit") === inputs[0]) {
      return inputs[0] as HTMLInputElement
    }
    await tick(20)
  }
  return null
}

describe("view smoke (real EditorView)", () => {
  it("keeps angle URL/email autolinks and reference labels visible", async () => {
    const { view, errors } = makeView(
      "[GitHub][]\n\n[GitHub]: https://github.com\n\n<example@email.com>\n\n<https://www.runoob.com>",
    )
    await tick()
    const text = view.dom.querySelector(".cm-content")?.textContent ?? ""
    expect(errors.map(String)).toEqual([])
    expect(text).toContain("GitHub")
    expect(text).toContain("example@email.com")
    expect(text).toContain("https://www.runoob.com")
    view.destroy()
  })

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

  it("keeps consecutive preview labels after reject", async () => {
    const { view, errors } = makeView("1. a\n3. b\n\ntail")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b\n\ntail")
    expect(view.dom.querySelectorAll(".omd-ordered-mark")[1]?.textContent).toBe("2.")
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

  it("table cell keyboard Tab and Shift-Tab restore focus after real rebuilds", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors } = makeView(doc)
    try {
      const first = await openTableBodyCell(view, 0)
      first.value = "x"
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))

      expect(view.state.doc.toString()).toContain("| x | 2 |")
      const second = await waitForTableEdit(view, 1)
      expect(second).toBeTruthy()

      second!.value = "y"
      second!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
      expect(view.state.doc.toString()).toContain("| x | y |")
      expect(await waitForTableEdit(view, 0)).toBeTruthy()
      expect(errors.map(String)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it("table cell keyboard continuation follows the table live position", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors } = makeView(doc)
    try {
      expect(await waitFor(".omd-table", view)).toBeTruthy()
      view.dispatch({ changes: { from: 0, insert: "prefix\n\n" } })
      const first = await openTableBodyCell(view, 0)
      first.value = "x"
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))

      expect(view.state.doc.toString()).toContain("prefix\n\n| a | b |")
      expect(view.state.doc.toString()).toContain("| x | 2 |")
      expect(await waitForTableEdit(view, 1)).toBeTruthy()
      expect(errors.map(String)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it("table cell keyboard continuation is isolated between editor views", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const first = makeView(doc)
    const second = makeView(doc)
    try {
      const input = await openTableBodyCell(first.view, 0)
      input.value = "x"
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
      second.view.dispatch({ changes: { from: second.view.state.doc.length, insert: "\n" } })

      expect(await waitForTableEdit(first.view, 1)).toBeTruthy()
      await tick()
      expect(second.view.dom.querySelectorAll("input.omd-table-edit")).toHaveLength(0)
      expect(first.errors.map(String)).toEqual([])
      expect(second.errors.map(String)).toEqual([])
    } finally {
      first.view.destroy()
      second.view.destroy()
    }
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

  it("enters opaque block source from its current decoration range", async () => {
    const doc = "intro\n\n$$\nx^2\n$$\n\ntail"
    const { view, errors } = makeView(doc)
    await tick()
    const block = view.dom.querySelector(".omd-math") as HTMLElement
    expect(block).toBeTruthy()
    expect(view.posAtDOM(block, 0)).toBe(doc.indexOf("$$"))
    expect(view.posAtDOM(block, -1)).toBe(doc.indexOf("$$"))
    vi.spyOn(view, "posAtCoords").mockReturnValue(doc.length)

    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))

    expect(view.state.selection.main.head).toBe(doc.indexOf("$$"))
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps a rendered code block mounted when clicking inside it (Typora live copy)", async () => {
    const doc = "before\n\n```powershell\nfirst\nsecond\nthird\n```\n\nafter"
    const { view, errors } = makeView(doc)
    const headBefore = view.state.selection.main.head
    const row = await waitFor(".omd-code .line", view, 3000)
    expect(row).toBeTruthy()
    ;(row as HTMLElement).dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
    }))
    await tick()
    expect(view.dom.querySelector(".omd-code")).toBeTruthy()
    expect(view.state.selection.main.head).toBe(headBefore)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps identical block widgets mounted when clicking either one", async () => {
    const block = "```js\nsame()\n```"
    const doc = `${block}\n\nmiddle\n\n${block}\n\ntail`
    const { view, errors } = makeView(doc)
    await tick()
    const widgets = view.dom.querySelectorAll(".omd-code")
    expect(widgets).toHaveLength(2)
    const headBefore = view.state.selection.main.head

    widgets[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))

    expect(view.state.selection.main.head).toBe(headBefore)
    expect(view.dom.querySelectorAll(".omd-code")).toHaveLength(2)
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

  it("keeps a block widget mounted with covered overlay when a selection fully covers it", async () => {
    const doc = "intro\n\n```ts\nconst a = 1\n```\n\noutro\n"
    const { view, errors } = makeView(doc)
    await tick()
    expect(view.dom.querySelector(".omd-block")).toBeTruthy()   // 光标在文末，块已渲染
    // 完整覆盖（Cmd+A 语义）→ 保持渲染 + 选中态覆盖类
    view.dispatch({ selection: { anchor: 0, head: doc.length } })
    await tick()
    const covered = view.dom.querySelector(".omd-block") as HTMLElement
    expect(covered).toBeTruthy()
    expect(covered.classList.contains("omd-block-covered")).toBe(true)
    // 光标进入块内 → widget 卸载，源码行可编辑
    const fenceEnd = doc.indexOf("\n", doc.indexOf("```ts")) + 1
    view.dispatch({ selection: { anchor: fenceEnd } })
    await tick()
    expect(view.dom.querySelector(".omd-code")).toBeNull()
    expect(view.dom.querySelector(".omd-codeblock")).toBeTruthy()
    // 光标离开 → 恢复渲染，覆盖类消失
    view.dispatch({ selection: { anchor: doc.length } })
    await tick()
    const restored = view.dom.querySelector(".omd-block") as HTMLElement
    expect(restored).toBeTruthy()
    expect(restored.classList.contains("omd-block-covered")).toBe(false)
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

  it("keeps source visible while typing the closing fence", async () => {
    const { view, errors } = makeView("```js\nlet x = 1\n``")
    view.dispatch({ changes: { from: 16, insert: "`" } })
    await tick()
    expect(view.dom.querySelector(".omd-code")).toBeNull()
    expect(view.dom.querySelector(".omd-codeblock")).toBeTruthy()
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

  it("keeps line-start and cross-line atoms out of atomic ranges", () => {
    const doc = "# Title\n\n> quoted\n\n- item\n\nSetext\n===\n\ntext with **bold** here\n"
    const state = EditorState.create({ doc, extensions: editorExtensions() })
    const { atomic } = state.field(livePreviewField)
    const ranges: [number, number][] = []
    atomic.between(0, doc.length, (from, to) => { ranges.push([from, to]) })
    for (const [from, to] of ranges) {
      const line = state.doc.lineAt(from)
      // 行首原子（#、>、- 等）与跨行原子（Setext underline）都不进原子集：
      // skipAtomsForSelection 会循环外推端点，这两类原子让外推跨过换行符、
      // 级联高亮下一行（指针选区同步 bug）。
      expect(from === line.from).toBe(false)
      expect(to <= line.to).toBe(true)
    }
    // 行中原子（**bold** 的两侧 **）保持原子化 —— WYSIWYG 选区应包住整个渲染粗体
    expect(ranges.some(([from, to]) => doc.slice(from, to) === "**")).toBe(true)
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

  it("renders fenced code inside a quote without splitting the quote", async () => {
    const doc = "> 运行：\n>\n> ```bash\n> npm install\n> npm start\n> ```\n>\n> 完成\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    expect(view.dom.querySelector(".omd-code")).toBeNull()
    const codeLines = [...view.dom.querySelectorAll(".omd-codeblock")]
    expect(codeLines.length).toBeGreaterThanOrEqual(2)
    expect(codeLines.every(el => el.classList.contains("omd-blockquote-1"))).toBe(true)
    expect(codeLines.some(el => el.textContent?.includes("npm install"))).toBe(true)
    expect(codeLines.some(el => el.textContent?.includes("npm start"))).toBe(true)
    expect(codeLines.every(el => !el.textContent?.includes(">"))).toBe(true)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("renders HTML entities as characters and leaves unicode emoji alone", async () => {
    const doc = "unicode 📚 and &#x1f4da; &#128218; &copy;\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    const entities = [...view.dom.querySelectorAll(".omd-entity")].map(el => el.textContent)
    expect(entities).toEqual(["📚", "📚", "©"])
    expect(view.dom.textContent).toContain("📚")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("renders a known gemoji shortcode as unicode and keeps the source", async () => {
    const doc = "celebrate :tada: please\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    const emoji = [...view.dom.querySelectorAll(".omd-emoji")].map(el => el.textContent)
    expect(emoji).toEqual(["🎉"])
    expect(view.state.doc.toString()).toContain(":tada:")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("renders a quote nested inside a list item", async () => {
    const doc = "* 第一项\n    > 菜鸟教程\n    > 学的不仅是技术更是梦想\n* 第二项\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    const quoteLines = [...view.dom.querySelectorAll(".omd-blockquote-1")]
    expect(quoteLines.length).toBeGreaterThanOrEqual(2)
    expect(quoteLines.every(el => el.classList.contains("omd-quote-in-li-1"))).toBe(true)
    expect(quoteLines.every(el => !el.classList.contains("omd-li-1"))).toBe(true)
    expect(quoteLines.some(el => el.textContent === "菜鸟教程")).toBe(true)
    expect(quoteLines.some(el => el.textContent === "学的不仅是技术更是梦想")).toBe(true)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("shows stacked depth classes for nested quotes", async () => {
    const doc = "> 最外层\n> > 第一层嵌套\n> > > 第二层嵌套\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    expect(view.dom.querySelector(".omd-blockquote-1")).toBeTruthy()
    expect(view.dom.querySelector(".omd-blockquote-2")).toBeTruthy()
    expect(view.dom.querySelector(".omd-blockquote-3")).toBeTruthy()
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("renders list markers inside a quote without throwing", async () => {
    const doc = "> 区块中使用列表\n> 1. 第一项\n> 2. 第二项\n> + 第一项\n> + 第二项\n> + 第三项\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    expect(view.dom.querySelectorAll(".omd-ordered-mark")).toHaveLength(2)
    expect(view.dom.querySelectorAll(".omd-bullet")).toHaveLength(3)
    const listLines = [...view.dom.querySelectorAll(".omd-li-1")]
    expect(listLines.length).toBeGreaterThanOrEqual(5)
    expect(listLines.every(el => el.classList.contains("omd-blockquote-1"))).toBe(true)
    expect(listLines.every(el => !el.classList.contains("omd-quote-in-li-1"))).toBe(true)
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps the nested quote line when clicking an empty quote line", async () => {
    const doc = "> 最外层\n>\n> > 第一层嵌套\n>\n> > > 第二层嵌套\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    view.dispatch({ selection: { anchor: doc.indexOf("\n>\n> > >") + 1 } })
    await tick()
    const nested = [...view.dom.querySelectorAll(".cm-line")]
      .find(el => el.textContent?.includes("第二层嵌套"))
    expect(nested?.className).toContain("omd-blockquote-3")
    expect(nested?.textContent).toBe("第二层嵌套")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps the inner quote line when clicking the leading empty quote line", async () => {
    const doc = "> 最外层\n>\n> > 第一层嵌套\n>\n> > > 第二层嵌套\n\noutside"
    const { view, errors } = makeView(doc)
    await tick()
    view.dispatch({ selection: { anchor: doc.indexOf("\n>\n> > ") + 1 } })
    await tick()
    const nested = [...view.dom.querySelectorAll(".cm-line")]
      .find(el => el.textContent?.includes("第一层嵌套"))
    expect(nested?.className).toContain("omd-blockquote-2")
    expect(nested?.textContent).toBe("第一层嵌套")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps quote chrome after clicking a blank line before a nested quote", async () => {
    const doc = "最外层\n\n> 第一层嵌套\n>\n> > 第二层嵌套"
    const { view, errors } = makeView(doc)
    await tick()
    view.dispatch({ selection: { anchor: doc.indexOf("\n\n>") + 1 } })
    await tick()
    const first = [...view.dom.querySelectorAll(".cm-line")]
      .find(el => el.textContent?.includes("第一层嵌套"))
    const nested = [...view.dom.querySelectorAll(".cm-line")]
      .find(el => el.textContent?.includes("第二层嵌套"))
    expect(first?.className).toContain("omd-blockquote-1")
    expect(nested?.className).toContain("omd-blockquote-2")
    expect(errors.map(String)).toEqual([])
    view.destroy()
  })

  it("keeps nested quote preview when clicking the inner content", async () => {
    const doc = [
      "> **用户反馈**：这个功能很有用！",
      ">",
      "> > **开发团队回复**：感谢您的反馈，我们会继续优化。",
      "> >",
      "> > > **项目经理补充**：预计下个版本会有更多改进。",
      "",
      "outside",
    ].join("\n")
    const { view, errors } = makeView(doc, doc.indexOf("感谢您的反馈"))
    await tick()
    const line = [...view.dom.querySelectorAll(".cm-line")]
      .find(el => el.textContent?.includes("感谢您的反馈"))
    expect(line?.classList.contains("omd-blockquote-2")).toBe(true)
    expect(line?.textContent).toBe("开发团队回复：感谢您的反馈，我们会继续优化。")
    expect(line?.textContent).not.toContain(">")
    expect(line?.textContent).not.toContain("**")
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
    expect(view.dom.querySelector(".omd-table.omd-blockquote-1")).toBeTruthy()
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

  function makeInteractView(doc: string) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const errors: unknown[] = []
    let docChanged = 0
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          editorExtensions(),
          EditorView.exceptionSink.of(e => { errors.push(e) }),
          EditorView.updateListener.of(u => { if (u.docChanged) docChanged++ }),
        ],
      }),
      parent,
    })
    return { view, errors, count: () => docChanged }
  }

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

  it("merges an open cell edit with an insert-row into one doc-changing transaction", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      const input = await openTableBodyCell(view, 0)
      input.value = "9"
      const before = count()
      const btn = view.dom.querySelector(".omd-table .omd-table-toolbar [data-act='insert-row']") as HTMLElement
      expect(btn).toBeTruthy()
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.click()
      await tick()
      // 合并为单一 doc 变更事务；单元格新值与新插入的行一次落盘。
      expect(count() - before).toBe(1)
      const out = view.state.doc.toString()
      expect(out).toContain("| 9 | 2 |")
      expect(out).toContain("|  |  |")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })

  it("two-phase delete-current-row completes against the rebuilt model", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      const input = await openTableBodyCell(view, 0)
      input.value = "9"
      const before = count()
      const btn = view.dom.querySelector(".omd-table .omd-table-toolbar [data-act='delete-row']") as HTMLElement
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.click()
      // 两次 doc 事务：先提交单元格，重建后对 fresh 元数据删除 active 行。
      const started = Date.now()
      while (Date.now() - started < 3000 && count() - before < 2) await tick(20)
      expect(count() - before).toBe(2)
      // active 行(row 1)被删；剩余 row 2 原样保留其值。
      expect(view.state.doc.toString()).toBe("| a | b |\n|---|---|\n| 3 | 4 |\n\ntail")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })

  it("two-phase delete-current-column completes against the rebuilt model", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      const input = await openTableBodyCell(view, 0)
      input.value = "9"
      const before = count()
      const btn = view.dom.querySelector(".omd-table .omd-table-toolbar [data-act='delete-col']") as HTMLElement
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.click()
      const started = Date.now()
      while (Date.now() - started < 3000 && count() - before < 2) await tick(20)
      expect(count() - before).toBe(2)
      // active 列被删；剩余列 b / 2 / 4 原样保留。
      expect(view.state.doc.toString()).toBe("| b |\n|---|\n| 2 |\n| 4 |\n\ntail")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })

  it("does not leak a deferred delete to another editor view", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntail"
    const first = makeInteractView(doc)
    const second = makeInteractView(doc)
    try {
      const input = await openTableBodyCell(first.view, 0)
      input.value = "9"
      const btn = first.view.dom.querySelector(".omd-table .omd-table-toolbar [data-act='delete-row']") as HTMLElement
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.click()
      const started = Date.now()
      while (Date.now() - started < 3000 && first.view.state.doc.toString().includes("| 9 | 2 |")) {
        await tick(20)
      }
      expect(first.view.state.doc.toString()).not.toContain("| 9 | 2 |")
      // 第二个视图未派发任何结构删除：文档逐字节未变。
      expect(second.view.state.doc.toString()).toBe(doc)
      expect(first.errors.map(String)).toEqual([])
      expect(second.errors.map(String)).toEqual([])
    } finally { first.view.destroy(); second.view.destroy() }
  })

  it("does not run a deferred delete on a table at another position", async () => {
    const doc = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "",
      "intro",
      "",
      "| c | d |",
      "|---|---|",
      "| 5 | 6 |",
      "",
      "tail",
    ].join("\n")
    const { view, errors } = makeInteractView(doc)
    try {
      const tbl = await waitFor(".omd-table", view)
      const firstCell = tbl!.querySelectorAll("tbody td")[0] as HTMLElement
      firstCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      const input = firstCell.querySelector("input.omd-table-edit") as HTMLInputElement
      expect(input).toBeTruthy()
      input.value = "9"
      const btn = view.dom.querySelectorAll(".omd-table .omd-table-toolbar [data-act='delete-row']")[0] as HTMLElement
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.click()
      // 等待结构删除真正发生：带 "9" 的 active 行消失（提交后、删除前仍含 "| 9 | 2 |"）。
      const started = Date.now()
      while (Date.now() - started < 3000 && view.state.doc.toString().includes("| 9 | 2 |")) {
        await tick(20)
      }
      const out = view.state.doc.toString()
      // 第一张表删除了 active 行；第二张表（不同位置）原样未动，pending 未串台。
      expect(out).toContain("| a | b |\n|---|---|\n| 3 | 4 |\n\nintro")
      expect(out).toContain("| c | d |\n|---|---|\n| 5 | 6 |")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
})
