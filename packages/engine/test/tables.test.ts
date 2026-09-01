import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { TableWidget, renderTableCellContent } from "../src/decorations/widgets/table"
import { imageResolver } from "../src/decorations/widgets/image"
import { tableDataFromNode } from "../src/tables/model"

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

  it("opens an omd-table-edit input on cell click and commits source on Enter", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const dispatches: unknown[] = []
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string }; selection?: unknown }) => {
        dispatches.push(spec)
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    const td = wrap.querySelector("td")!
    td.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input!.value).toBe("1")
    expect(input!.selectionStart).toBe(input!.value.length)
    expect(input!.selectionEnd).toBe(input!.value.length)
    expect(dispatches.some(d => d !== null && typeof d === "object" && "selection" in d)).toBe(false)
    input!.value = "x"
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    expect(doc).toBe("| a | b |\n|---|---|\n| x | 2 |")
  })

  it("inserts a row below from the table toolbar", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const insertRow = wrap.querySelector(".omd-table-toolbar [data-act='insert-row']") as HTMLElement
    expect(insertRow).toBeTruthy()
    insertRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    insertRow.click()
    expect(doc).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |")
  })

  it("deletes the clicked data row, not the one below it", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    // 点击第一个数据行（tbody 的第一个 td）——行号 1（1-based）。
    wrap.querySelector("tbody td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const deleteRow = wrap.querySelector(".omd-table-toolbar [data-act='delete-row']") as HTMLElement
    deleteRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    deleteRow.click()
    // 移除第一数据行，而不是其下方的第二行。
    expect(doc).toBe("| a | b |\n|---|---|\n| 3 | 4 |")
  })

  it("does not delete a data row when the header cell is active", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    // 点击表头单元格（行 0）：delete-row 应被守卫为 no-op，不变化任何源码。
    wrap.querySelector("th")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const deleteRow = wrap.querySelector(".omd-table-toolbar [data-act='delete-row']") as HTMLElement
    deleteRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    deleteRow.click()
    expect(doc).toBe(src)
  })

  it("does not restart editing on the detached widget after Tab", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } | Array<{ from: number; to: number; insert: string }> }) => {
        if (spec.changes) {
          // 结构操作返回多条 table-relative change；像 CodeMirror 一样按
          // 位置降序应用，避免先应用低位置改动使后续偏移失效。
          const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
          for (const change of [...list].sort((a, b) => b.from - a.from)) {
            doc = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
          }
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    const deleteCol = wrap.querySelector(".omd-table-toolbar [data-act='delete-col']") as HTMLElement
    deleteCol.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    deleteCol.click()
    expect(doc).toBe("| b |\n|---|\n| 2 |")
  })

  it("replaces the live table range after the widget position moves", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = `xx\n\n${src}`
    const dispatches: Array<{ from: number; to: number; insert: string }> = []
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 4,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          dispatches.push(spec.changes)
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const data = tableData(src)
    const cell = data.rows[0].cells[0]!
    const widget = new TableWidget(src, 0, data)
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "x"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    expect(dispatches[0]).toMatchObject({ from: 4 + cell.from, to: 4 + cell.to, insert: "x" })
    expect(doc).toBe("xx\n\n| a | b |\n|---|---|\n| x | 2 |")
  })

  it("keeps the cell editor when deleting the last data row fails", async () => {
    const src = "| a |\n|---|\n| 1 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const deleteRow = wrap.querySelector(".omd-table-toolbar [data-act='delete-row']") as HTMLElement
    deleteRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    deleteRow.click()
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(doc).toBe(src)
    input!.value = "x"
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    expect(doc).toBe("| a |\n|---|\n| x |")
  })

  it("lets the edit input keep native mousedown for caret placement", async () => {
    const src = "| a |\n|---|\n| 1 |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(wrap.querySelector("input.omd-table-edit")).toBe(input)
  })

  it("opens escaped cell source in the editor", async () => {
    const src = "| a\\|b | c |\n|---|---|\n| 1 | 2 |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelector("th")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    expect((wrap.querySelector("input.omd-table-edit") as HTMLInputElement).value).toBe("a\\|b")
  })

  it("does not open an editor for a synthetic ragged cell", async () => {
    const src = "| a | b |\n|---|---|\n| only |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelectorAll("td")[1]
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    expect(wrap.querySelector("input.omd-table-edit")).toBeNull()
  })

  it("does not resume Tab editing on a synthetic ragged cell after rebuild", async () => {
    const src = "| a | b |\n|---|---|\n| only |"
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      posAtDOM: () => 0,
      dispatch: () => {},
    }
    const first = new TableWidget(src, 0, tableData(src))
    const firstWrap = first.toDOM(view as never)
    await Promise.resolve()
    firstWrap.querySelector("td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    firstWrap.querySelector("input.omd-table-edit")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))

    const rebuilt = new TableWidget(src, 0, tableData(src))
    const rebuiltWrap = rebuilt.toDOM(view as never)
    await Promise.resolve()
    expect(rebuiltWrap.querySelector("input.omd-table-edit")).toBeNull()
  })

  it("keeps pending table keyboard continuation scoped to its EditorView", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const firstView = {
      state: { readOnly: false },
      requestMeasure: () => {},
      posAtDOM: () => 0,
      dispatch: () => {},
    }
    const secondView = {
      state: { readOnly: false },
      requestMeasure: () => {},
      posAtDOM: () => 0,
      dispatch: () => {},
    }
    const first = new TableWidget(src, 0, tableData(src))
    const firstWrap = first.toDOM(firstView as never)
    document.body.appendChild(firstWrap)
    await Promise.resolve()
    firstWrap.querySelector("td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    firstWrap.querySelector("input.omd-table-edit")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))

    const unrelated = new TableWidget(src, 0, tableData(src))
    const unrelatedWrap = unrelated.toDOM(secondView as never)
    document.body.appendChild(unrelatedWrap)
    await Promise.resolve()

    expect(unrelatedWrap.querySelector("input.omd-table-edit")).toBeNull()
    firstWrap.remove()
    unrelatedWrap.remove()
  })

  it("opens an empty cell with a collapsed caret", async () => {
    const src = "| a |\n|---|\n|   |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelector("td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(0)
  })

  it("merges an open cell commit and an insert-row into one sorted transaction", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const dispatches: unknown[] = []
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } | Array<{ from: number; to: number; insert: string }> }) => {
        dispatches.push(spec)
        if (spec.changes) {
          const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
          for (const change of [...list].sort((a, b) => b.from - a.from)) {
            doc = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
          }
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    // 打开第一个数据单元格，输入新值，再点「下插一行」。
    wrap.querySelector("tbody td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "9"
    const insertRow = wrap.querySelector(".omd-table-toolbar [data-act='insert-row']") as HTMLElement
    insertRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    insertRow.click()
    // 单个事务同时携带单元格改动与行插入（2 个排序、非重叠的本地 change）。
    expect(dispatches).toHaveLength(1)
    const changes = (dispatches[0] as { changes: Array<{ from: number; to: number; insert: string }> }).changes
    expect(changes).toHaveLength(2)
    expect(changes.map(c => c.from)).toEqual([...changes].sort((a, b) => a.from - b.from).map(c => c.from))
    expect(doc).toBe("| a | b |\n|---|---|\n| 9 | 2 |\n|  |  |")
  })

  it("dispatches local structural changes, not a whole-table replacement, without an open editor", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const dispatches: Array<{ changes?: Array<{ from: number; to: number; insert: string }> }> = []
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } | Array<{ from: number; to: number; insert: string }> }) => {
        dispatches.push(spec as never)
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    // 不打开任何单元格编辑器（this.row/this.col 仍为表头默认 0）直接加一列。
    const insertCol = wrap.querySelector(".omd-table-toolbar [data-act='insert-col']") as HTMLElement
    insertCol.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    insertCol.click()
    expect(dispatches).toHaveLength(1)
    const changes = dispatches[0].changes
    expect(changes).toBeTruthy()
    // 三处本地 change（表头、分隔符、首数据行），均不覆盖整表 —— 不是全表替换。
    expect(changes!.length).toBe(3)
    for (const c of changes!) {
      expect(c.from).toBeGreaterThanOrEqual(0)
      expect(c.to).toBeLessThanOrEqual(src.length)
      expect(c.from).not.toBe(0)
      expect(c.to).not.toBe(src.length)
    }
  })

  it("disables delete-row when there is one data row and delete-column when there is one column", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const delRow = wrap.querySelector("[data-act='delete-row']") as HTMLButtonElement
    const delCol = wrap.querySelector("[data-act='delete-col']") as HTMLButtonElement
    expect(delRow.disabled).toBe(true)
    expect(delCol.disabled).toBe(false)

    const oneColSrc = "| a |\n|---|\n| 1 |\n| 2 |"
    const oneCol = new TableWidget(oneColSrc, 0, tableData(oneColSrc))
    const wrap2 = oneCol.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const delRow2 = wrap2.querySelector("[data-act='delete-row']") as HTMLButtonElement
    const delCol2 = wrap2.querySelector("[data-act='delete-col']") as HTMLButtonElement
    expect(delRow2.disabled).toBe(false)
    expect(delCol2.disabled).toBe(true)
  })

  it("applies active row and column classes to the edited cell row and column", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const bodyTds = wrap.querySelectorAll("tbody td")
    const target = bodyTds[1] as HTMLElement  // row1 col1
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    expect(target.classList.contains("omd-table-row-active")).toBe(true)
    expect(target.classList.contains("omd-table-col-active")).toBe(true)
    // 同行的另一格只带 row-active
    expect((bodyTds[0] as HTMLElement).classList.contains("omd-table-row-active")).toBe(true)
    expect((bodyTds[0] as HTMLElement).classList.contains("omd-table-col-active")).toBe(false)
    // 该列的下方格子只带 col-active
    expect((bodyTds[3] as HTMLElement).classList.contains("omd-table-col-active")).toBe(true)
    expect((bodyTds[3] as HTMLElement).classList.contains("omd-table-row-active")).toBe(false)
    // 表头同列也带 col-active
    expect((wrap.querySelectorAll("th")[1] as HTMLElement).classList.contains("omd-table-col-active")).toBe(true)
    // Escape 取消后 active 类清空
    target.querySelector("input.omd-table-edit")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(wrap.querySelector(".omd-table-row-active")).toBeNull()
    expect(wrap.querySelector(".omd-table-col-active")).toBeNull()
  })

  it("renders synthetic ragged cells disabled and input-less", async () => {
    const src = "| a | b |\n|---|---|\n| only |"
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const missing = wrap.querySelectorAll("td")[1] as HTMLElement
    expect(missing.classList.contains("omd-table-cell-missing")).toBe(true)
    expect(missing.getAttribute("aria-disabled")).toBe("true")
    expect(missing.title).toBe("Missing source cell; add a column or edit Markdown source")
    expect(missing.querySelector("input")).toBeNull()
    expect((wrap.querySelectorAll("td")[0] as HTMLElement).classList.contains("omd-table-cell-missing")).toBe(false)
  })

  it("Enter in the final cell commits without inserting a row", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
        if (spec.changes) {
          const { from, to, insert } = spec.changes
          doc = doc.slice(0, from) + insert + doc.slice(to)
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelectorAll("tbody td")[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "x"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    // Enter 在末格只提交，绝不因 move=1 而附加空行。
    expect(doc).toBe("| a | b |\n|---|---|\n| 1 | x |")
  })

  it("final-cell Tab commits the cell and appends one blank row focusing its first cell", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    let doc = src
    const view = {
      state: { readOnly: false },
      requestMeasure: () => {},
      focus: () => {},
      posAtCoords: () => 0,
      posAtDOM: () => 0,
      dispatch: (spec: { changes?: { from: number; to: number; insert: string } | Array<{ from: number; to: number; insert: string }> }) => {
        if (spec.changes) {
          const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
          for (const change of [...list].sort((a, b) => b.from - a.from)) {
            doc = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
          }
        }
      },
    }
    const widget = new TableWidget(src, 0, tableData(src))
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelectorAll("tbody td")[1]
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "x"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(doc).toBe("| a | b |\n|---|---|\n| 1 | x |\n|  |  |")

    // 重建后的 widget 消费 pending，打开新行首格。pending 的微任务要求
    // cell.isConnected，widget 挂到 document 后再让微任务跑。
    const rebuilt = new TableWidget(doc, 0, tableData(doc))
    const rebuiltWrap = rebuilt.toDOM(view as never)
    document.body.appendChild(rebuiltWrap)
    // pending 消费的 startEdit 在微任务里执行，happy-dom 下需一次任务轮转。
    await new Promise(resolve => setTimeout(resolve, 20))
    const newRowCells = rebuiltWrap.querySelectorAll("tbody tr")[1].querySelectorAll("td")
    expect(newRowCells[0].querySelector("input.omd-table-edit")).toBeTruthy()
    rebuiltWrap.remove()
  })

})
