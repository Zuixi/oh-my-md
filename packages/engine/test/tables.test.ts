import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { TableWidget, renderTableCellContent } from "../src/decorations/widgets/table"
import { imageResolver } from "../src/decorations/widgets/image"
import { tableDataFromNode } from "../src/tables/model"
import { editorExtensions } from "../src/index"

const doc = "| a | b |\n|---|---|\n| 1 | 2 |"

function tableData(source: string) {
  const state = makeState(source)
  let table: SyntaxNode | null = null
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") {
      table = cursor.node
      break
    }
  } while (cursor.next())
  if (!table) throw new Error("expected a Table node")
  const data = tableDataFromNode(table, state)
  if (!data) throw new Error("expected table data")
  return data
}

describe("tables", () => {
  it("renders as a block widget when cursor is outside", () => {
    const state = makeState(`intro\n\n${doc}\n\ntail`)
    const s = state.update({ selection: { anchor: 0 } }).state
    const t = collectDecorationSpecs(s, 0, s.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain(`widget:block:table@7-${7 + doc.length}`)
  })

  it("shows source (no widget) when cursor is inside the table", () => {
    const state = makeState(doc)
    const s = state.update({ selection: { anchor: 5 } }).state
    const t = collectDecorationSpecs(s, 0, s.doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:table")
  })

  it("keeps a caret resting exactly on the end boundary in source editing", () => {
    // 「粘贴后需按 Enter」的修复在粘贴侧做边界规整（paste/blockBoundaries.ts），
    // 装饰层不得为「光标恰在 node.to」开渲染例外：手敲表格收尾时光标也停在
    // node.to，例外会让 widget 在打字中途吞掉正在编辑的行（M2 围栏同类回归）。
    const state = makeState(doc)
    const s = state.update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, s.doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:table")
  })

  it("inline marks inside cells do not emit decorations under the widget", () => {
    const s2 = makeState(`x\n\n| **a** |\n|---|\n| b |`)
    const s3 = s2.update({ selection: { anchor: 0 } }).state
    const t = collectDecorationSpecs(s3, 0, s3.doc.length).map(d => d.tag)
    expect(t).toContain("widget:block:table")
    expect(t).not.toContain("mark:omd-strong")  // 子树被跳过
  })

  it("renders rich formatting and line breaks inside table cells", () => {
    const div = document.createElement("div")
    renderTableCellContent(div, "Item 1<br><br>_italic_ and **bold** with `code` and [link](https://example.com)")

    expect(div.querySelectorAll("br").length).toBe(2)
    expect(div.querySelector("em")?.textContent).toBe("italic")
    expect(div.querySelector("strong")?.textContent).toBe("bold")
    expect(div.querySelector("code")?.textContent).toBe("code")
    const link = div.querySelector("a")
    expect(link?.textContent).toBe("link")
    expect(link?.href).toBe("https://example.com/")
  })

  it("renders full inline markdown inside cells", () => {
    const div = document.createElement("div")
    renderTableCellContent(div, "==hi== <u>u</u> ~~no~~ $x$ :smile: &copy; https://example.com")

    expect(div.querySelector("mark")?.textContent).toBe("hi")
    expect(div.querySelector("u")?.textContent).toBe("u")
    expect(div.querySelector("del")?.textContent).toBe("no")
    expect(div.querySelector(".omd-cell-math")?.textContent).toBe("x")
    expect(div.textContent).toContain("😄")       // :smile: → emoji
    expect(div.textContent).toContain("©")        // &copy; → entity
    const link = div.querySelector("a")
    expect(link?.textContent).toBe("https://example.com")  // bare URL → autolink
    expect(link?.href).toBe("https://example.com/")
  })

  it("renders block-level markdown inside cells: lists, quotes, and fenced code", () => {
    const list = document.createElement("div")
    renderTableCellContent(list, "- one")
    expect(list.querySelector("ul")).toBeTruthy()
    expect(list.querySelector("li")?.textContent).toBe("one")

    const quote = document.createElement("div")
    renderTableCellContent(quote, "> cited")
    expect(quote.querySelector("blockquote")?.textContent).toContain("cited")

    const ordered = document.createElement("div")
    renderTableCellContent(ordered, "1. first")
    expect(ordered.querySelector("ol")?.querySelector("li")?.textContent).toBe("first")

    const pre = document.createElement("div")
    renderTableCellContent(pre, "```js\nconst x = 1\n```")
    expect(pre.querySelector("pre code")?.textContent).toContain("const x = 1")
  })

  it("renders table widget DOM with parsed rich cells", async () => {
    const src = "| Item | Details |\n|---|---|\n| Func | Line 1<br>_note_ |"
    const widget = new TableWidget(src, 0, tableData(src))
    const dom = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const td = dom.querySelectorAll("td")[1]
    expect(td.querySelector("br")).toBeTruthy()
    expect(td.querySelector("em")?.textContent).toBe("note")
  })

  it("resolves cell images through the widget resolveSrc", async () => {
    const src = "| Pic |\n|---|\n| ![a](x.png) |"
    const widget = new TableWidget(src, 0, tableData(src), undefined, path => `/res/${path}`)
    const dom = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    expect((dom.querySelector("td img") as HTMLImageElement).src).toContain("/res/x.png")
  })

  it("threads the host image resolver facet into the table widget", async () => {
    const doc = "intro\n\n| Pic |\n|---|\n| ![a](x.png) |"
    const state = makeState(doc, [imageResolver.of((s: string) => `/facet/${s}`)])
    const s = state.update({ selection: { anchor: 0 } }).state
    const spec = collectDecorationSpecs(s, 0, s.doc.length).find(d => d.tag === "widget:block:table")
    expect(spec).toBeTruthy()
    const widget = (spec!.deco.spec as unknown as { widget: TableWidget }).widget
    const dom = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    expect((dom.querySelector("td img") as HTMLImageElement).src).toContain("/facet/x.png")
  })

  // 渲染态（光标在表外）只有投影 + 结构工具栏：没有输入框、没有"正在编辑哪一格"。
  // 工具栏的目标格唯一来源是鼠标 hover（td/th 的 mouseover 记录行列），动作经
  // tables/sourceToolbar.ts::applyTableToolAt 校验偏移后改写源码。
  type ToolChange = { from: number; to: number; insert: string }

  /** 只实现 applyTableToolAt 用到的 view 表面：state.sliceDoc 校验 + dispatch 落盘。 */
  function toolView(initial: string, tablePos = 0) {
    let text = initial
    const dispatches: Array<{ changes?: ToolChange | readonly ToolChange[] }> = []
    const view = {
      state: { readOnly: false, sliceDoc: (from: number, to: number) => text.slice(from, to) },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => tablePos,
      dispatch: (spec: { changes?: ToolChange | readonly ToolChange[] }) => {
        // toDOM 末尾还会派发一次 measureBlockWidget 测量 effect —— 只统计文档事务。
        if (!spec.changes) return
        dispatches.push(spec)
        const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
        for (const change of [...list].sort((a, b) => b.from - a.from)) {
          text = text.slice(0, change.from) + change.insert + text.slice(change.to)
        }
      },
    }
    return { view, dispatches, doc: () => text }
  }

  function hover(el: Element) {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
  }

  function clickTool(wrap: HTMLElement, act: string) {
    const btn = wrap.querySelector(`.omd-table-toolbar [data-act='${act}']`) as HTMLButtonElement
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    // 只有 hover 过格子的按钮才 enabled；disabled 的 button.click() 是 no-op，
    // 所以这里用 dispatchEvent 让监听器无条件收到 click（等价于程序化触发）。
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  }

  /** doc 可与 widget 自己的 src 不同（模拟表格前插入内容后的 live position）。 */
  async function mountTable(src: string, options: { tablePos?: number; doc?: string } = {}) {
    const { view, dispatches, doc } = toolView(options.doc ?? src, options.tablePos ?? 0)
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    return { widget, wrap, dispatches, doc }
  }

  it("keeps the rendered toolbar inert until a cell is hovered", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { widget, wrap, dispatches } = await mountTable(src)
    expect(widget.hasRowCol()).toBe(false)
    const buttons = [...wrap.querySelectorAll<HTMLButtonElement>(".omd-table-toolbar button")]
    expect(buttons).toHaveLength(7)
    expect(buttons.every(btn => btn.disabled)).toBe(true)

    // 未 hover 就点：没有目标格，绝不猜（不改源码、不派发事务）。
    clickTool(wrap, "insert-row")
    expect(dispatches).toHaveLength(0)

    hover(wrap.querySelectorAll("td")[0])
    expect(widget.hasRowCol()).toBe(true)
    expect((wrap.querySelector("[data-act='insert-row']") as HTMLButtonElement).disabled).toBe(false)
  })

  it("inserts a row below the hovered row from the rendered toolbar", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { wrap, doc } = await mountTable(src)
    hover(wrap.querySelector("tbody td")!)
    clickTool(wrap, "insert-row")
    expect(doc()).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |")
  })

  it("deletes the hovered data row, not the one below it", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    const { wrap, doc } = await mountTable(src)
    // 第一个数据行（行序 1）为目标 —— 删它，而不是它下面的第二行。
    hover(wrap.querySelector("tbody td")!)
    clickTool(wrap, "delete-row")
    expect(doc()).toBe("| a | b |\n|---|---|\n| 3 | 4 |")
  })

  it("does not delete a data row when the hovered target is the header", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    const { wrap, doc, dispatches } = await mountTable(src)
    hover(wrap.querySelector("th")!)
    clickTool(wrap, "delete-row")
    // 表头映射到 -1，被 deleteTableRow 的边界检查拒绝 —— 一个事务都不产生。
    expect(doc()).toBe(src)
    expect(dispatches).toHaveLength(0)
  })

  it("applies the toolbar action at the table's live position, not its stale pos", async () => {
    // widget 的 pos 是 0，但它在文档里已经下移了 4 个字符：动作必须落在 livePos。
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    const { wrap, doc } = await mountTable(src, { tablePos: 4, doc: `xx\n\n${src}` })
    hover(wrap.querySelector("td")!)
    clickTool(wrap, "delete-col")
    expect(doc()).toBe("xx\n\n| b |\n|---|\n| 2 |\n| 4 |")
  })

  it("dispatches local structural changes, not a whole-table replacement", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { wrap, dispatches } = await mountTable(src)
    // 目标列 0（首数据格）→ 在其右侧插列。
    hover(wrap.querySelector("tbody td")!)
    clickTool(wrap, "insert-col")
    expect(dispatches).toHaveLength(1)
    const changes = dispatches[0].changes as readonly ToolChange[]
    // 三处本地 change（表头、分隔符、首数据行），均不覆盖整表 —— 不是全表替换。
    expect(changes.length).toBe(3)
    for (const c of changes) {
      expect(c.from).toBeGreaterThanOrEqual(0)
      expect(c.to).toBeLessThanOrEqual(src.length)
      expect(c.from).not.toBe(0)
      expect(c.to).not.toBe(src.length)
    }
  })

  it("disables delete-row when there is one data row and delete-column when there is one column", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { wrap } = await mountTable(src)
    hover(wrap.querySelector("td")!)
    expect((wrap.querySelector("[data-act='delete-row']") as HTMLButtonElement).disabled).toBe(true)
    expect((wrap.querySelector("[data-act='delete-col']") as HTMLButtonElement).disabled).toBe(false)

    const oneColSrc = "| a |\n|---|\n| 1 |\n| 2 |"
    const oneCol = await mountTable(oneColSrc)
    hover(oneCol.wrap.querySelector("td")!)
    expect((oneCol.wrap.querySelector("[data-act='delete-row']") as HTMLButtonElement).disabled).toBe(false)
    expect((oneCol.wrap.querySelector("[data-act='delete-col']") as HTMLButtonElement).disabled).toBe(true)
  })

  it("ignores a synthetic ragged cell as a toolbar target", async () => {
    const src = "| a | b |\n|---|---|\n| only |"
    const { widget, wrap } = await mountTable(src)
    // 缺失源码槽的占位格没有任何可操作的东西：hover 它不建立目标。
    hover(wrap.querySelectorAll("td")[1])
    expect(widget.hasRowCol()).toBe(false)
    expect((wrap.querySelector("[data-act='insert-row']") as HTMLButtonElement).disabled).toBe(true)
  })

  it("renders synthetic ragged cells disabled and input-less", async () => {
    const src = "| a | b |\n|---|---|\n| only |"
    const { wrap } = await mountTable(src)
    const missing = wrap.querySelectorAll("td")[1] as HTMLElement
    expect(missing.classList.contains("omd-table-cell-missing")).toBe(true)
    expect(missing.getAttribute("aria-disabled")).toBe("true")
    expect(missing.title).toBe("Missing source cell; add a column or edit Markdown source")
    expect(missing.querySelector("input")).toBeNull()
    expect((wrap.querySelectorAll("td")[0] as HTMLElement).classList.contains("omd-table-cell-missing")).toBe(false)
  })
})

// 交叉视图隔离：渲染态工具栏的 hover 目标、以及 widget DOM 监听器的归属解析
// （模块级 `domOwner` WeakMap）都不得跨视图串味。旧的"两个视图各开一个 cell input"
// 泄漏测试随输入框一起删掉了（Task 8），这里是它的替身：任何"记住上次的目标"都会
// 在另一个视图里显现成一次不该发生的改写。
const DOC_A = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
const DOC_B = "| x | y |\n|---|---|\n| 3 | 4 |\n\ntail"

/** 真实 EditorView，光标停在文末（表格处于渲染态）。 */
function mountLive(source: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  return { view, errors, cleanup: () => { view.destroy(); parent.remove() } }
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

/** 装饰构建是渐进式的：等渲染态表格 DOM 出现再 hover。 */
async function waitTable(view: EditorView, timeout = 3000): Promise<HTMLElement | null> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const match = view.dom.querySelector<HTMLElement>(".omd-table")
    if (match) return match
    await tick()
  }
  return null
}

describe("rendered toolbar targets stay inside their own view", () => {
  it("edits only the view whose toolbar was clicked", async () => {
    const a = mountLive(DOC_A)
    const b = mountLive(DOC_B)
    try {
      const wrapA = await waitTable(a.view)
      const wrapB = await waitTable(b.view)
      expect(wrapA).toBeTruthy()
      expect(wrapB).toBeTruthy()

      // 只在 A 里 hover，然后点 A 自己的渲染态工具栏。
      wrapA!.querySelector("tbody td")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
      const btn = wrapA!.querySelector("[data-act='insert-row']") as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

      expect(a.view.state.doc.toString()).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |\n\ntail")
      // B 的文档逐字节不变，且它的工具栏依旧是"没有目标格"（没被 A 的 hover 点亮）。
      expect(b.view.state.doc.toString()).toBe(DOC_B)
      expect((wrapB!.querySelector("[data-act='insert-row']") as HTMLButtonElement).disabled).toBe(true)
      expect(a.errors.map(String)).toEqual([])
      expect(b.errors.map(String)).toEqual([])
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })
})
