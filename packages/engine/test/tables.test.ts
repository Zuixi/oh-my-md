import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { TableWidget, renderTableCellContent } from "../src/decorations/widgets/table"
import { imageResolver } from "../src/decorations/widgets/image"

const doc = "| a | b |\n|---|---|\n| 1 | 2 |"

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
    const widget = new TableWidget(
      "| Item | Details |\n|---|---|\n| Func | Line 1<br>_note_ |",
      0,
      {
        header: ["Item", "Details"],
        rows: [["Func", "Line 1<br>_note_"]],
        aligns: ["left", "left"],
      },
    )
    const dom = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    const td = dom.querySelectorAll("td")[1]
    expect(td.querySelector("br")).toBeTruthy()
    expect(td.querySelector("em")?.textContent).toBe("note")
  })

  it("resolves cell images through the widget resolveSrc", async () => {
    const widget = new TableWidget(
      "| Pic |\n|---|\n| ![a](x.png) |",
      0,
      { header: ["Pic"], rows: [["![a](x.png)"]], aligns: [""] },
      undefined,
      src => `/res/${src}`,
    )
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
    const widget = new TableWidget(src, 0, {
      header: ["a", "b"],
      rows: [["1", "2"]],
      aligns: ["", ""],
    })
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
    const widget = new TableWidget(src, 0, {
      header: ["a", "b"],
      rows: [["1", "2"]],
      aligns: ["", ""],
    })
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const insertRow = wrap.querySelector(".omd-table-toolbar [data-act='insert-row']") as HTMLElement
    expect(insertRow).toBeTruthy()
    insertRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    insertRow.click()
    expect(doc).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |")
  })

  it("toolbar follows the cell reached by Tab", async () => {
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
    const widget = new TableWidget(src, 0, {
      header: ["a", "b"],
      rows: [["1", "2"]],
      aligns: ["", ""],
    })
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    const deleteCol = wrap.querySelector(".omd-table-toolbar [data-act='delete-col']") as HTMLElement
    deleteCol.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    deleteCol.click()
    expect(doc).toBe("| a |\n|---|\n| 1 |")
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
    const widget = new TableWidget(src, 0, {
      header: ["a", "b"],
      rows: [["1", "2"]],
      aligns: ["", ""],
    })
    const wrap = widget.toDOM(view as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "x"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    expect(dispatches[0]).toMatchObject({ from: 4, to: 4 + src.length })
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
    const widget = new TableWidget(src, 0, {
      header: ["a"],
      rows: [["1"]],
      aligns: [""],
    })
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
    const widget = new TableWidget("| a |\n|---|\n| 1 |", 0, {
      header: ["a"],
      rows: [["1"]],
      aligns: [""],
    })
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelector("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(wrap.querySelector("input.omd-table-edit")).toBe(input)
  })

  it("opens an empty cell with a collapsed caret", async () => {
    const widget = new TableWidget("| a |\n|---|\n|   |", 0, {
      header: ["a"],
      rows: [[""]],
      aligns: [""],
    })
    const wrap = widget.toDOM({ requestMeasure: () => {}, state: { readOnly: false } } as never)
    await Promise.resolve()
    wrap.querySelector("td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = wrap.querySelector("input.omd-table-edit") as HTMLInputElement
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(0)
  })
})
