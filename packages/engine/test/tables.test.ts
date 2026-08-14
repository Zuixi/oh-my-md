import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { TableWidget, renderTableCellContent } from "../src/decorations/widgets/table"

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
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    await Promise.resolve()
    const td = dom.querySelectorAll("td")[1]
    expect(td.querySelector("br")).toBeTruthy()
    expect(td.querySelector("em")?.textContent).toBe("note")
  })
})
