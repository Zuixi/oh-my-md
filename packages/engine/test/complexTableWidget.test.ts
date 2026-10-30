import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView, type WidgetType } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions, imageResolver } from "../src/index"
import { collectDecorationSpecs, drainPendingLiveBuild, livePreviewField } from "../src/decorations/build"
import { ComplexTableWidget } from "../src/decorations/widgets/complexTable"
import { estimateComplexTableHeightPx } from "../src/decorations/widgetHeights"
import { blockEntryPosition } from "../src/navigation/blockEntry"
import { measureBlockWidget } from "../src/decorations/widgetMeasure"
import { makeState } from "./helpers"

const COMPLEX_TABLE_DOC = [
  "before",
  "",
  "<table>",
  "<thead>",
  "<tr>",
  '<th scope="col" colspan="2" align="center">Summary</th>',
  "</tr>",
  "</thead>",
  "<tbody>",
  "<tr>",
  '<td rowspan="2" align="left">Group</td>',
  '<td><strong>Bold</strong><br><a href="https://example.com" title="Ex">Link</a> <img src="./assets/pic.png" alt="pic"></td>',
  "</tr>",
  "<tr>",
  "<td><code>x = 1</code></td>",
  "</tr>",
  "</tbody>",
  "</table>",
  "",
  "after",
].join("\n")

describe("ComplexTableWidget", () => {
  it("mounts ComplexTableWidget for a valid complex table HTMLBlock and leaves arbitrary HTMLBlock untouched", () => {
    let state = makeState(`${COMPLEX_TABLE_DOC}\n\n<div>plain html</div>\n\ntail`)
    state = state.update({ selection: { anchor: state.doc.length } }).state
    const specs = collectDecorationSpecs(state, 0, state.doc.length)

    const complexSpecs = specs.filter(s => s.tag === "widget:block:complex-table")
    expect(complexSpecs).toHaveLength(1)
    const widget = (complexSpecs[0].deco.spec as { widget?: WidgetType }).widget as ComplexTableWidget
    expect(widget).toBeInstanceOf(ComplexTableWidget)
    expect(widget.estimatedHeight).toBe(estimateComplexTableHeightPx(widget.model))
    expect(widget.estimatedHeight).toBeGreaterThan(0)
  })

  it("renders table DOM with rowspan, colspan, scope, align, resolved images, and no GFM toolbar", async () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const state = EditorState.create({
      doc: COMPLEX_TABLE_DOC,
      extensions: [
        ...editorExtensions(),
        imageResolver.of(src => `asset://local/${src.replace(/^\.\//, "")}`),
      ],
      selection: { anchor: COMPLEX_TABLE_DOC.length },
    })
    const view = new EditorView({ state, parent })
    try {
      forceParsing(view, COMPLEX_TABLE_DOC.length, 10000)
      drainPendingLiveBuild(view)
      await new Promise(resolve => setTimeout(resolve, 10))

      const wrap = view.dom.querySelector<HTMLElement>(".omd-complex-table")
      expect(wrap).toBeTruthy()
      expect(wrap?.querySelector(".omd-table-toolbar")).toBeNull()
      expect(wrap?.querySelector(".omd-table-cell-input")).toBeNull()

      const th = wrap?.querySelector<HTMLTableCellElement>("thead th")
      expect(th?.colSpan).toBe(2)
      expect(th?.scope).toBe("col")
      expect(th?.style.textAlign).toBe("center")

      const firstTd = wrap?.querySelector<HTMLTableCellElement>("tbody tr:first-child td:first-child")
      expect(firstTd?.rowSpan).toBe(2)
      expect(firstTd?.style.textAlign).toBe("left")

      const img = wrap?.querySelector<HTMLImageElement>("tbody img.omd-image")
      expect(img?.getAttribute("src")).toBe("asset://local/assets/pic.png")
      expect(img?.alt).toBe("pic")

      const link = wrap?.querySelector<HTMLAnchorElement>("tbody a.omd-link")
      expect(link?.getAttribute("href")).toBe("https://example.com")
      expect(link?.title).toBe("Ex")
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("reveals raw HTMLBlock source when the selection enters the block and restores the widget when leaving", async () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const tableFrom = COMPLEX_TABLE_DOC.indexOf("<table>")
    const state = EditorState.create({
      doc: COMPLEX_TABLE_DOC,
      extensions: editorExtensions(),
      selection: { anchor: COMPLEX_TABLE_DOC.length },
    })
    const view = new EditorView({ state, parent })
    try {
      forceParsing(view, COMPLEX_TABLE_DOC.length, 10000)
      drainPendingLiveBuild(view)
      expect(
        view.state.field(livePreviewField).specs.some(s => s.tag === "widget:block:complex-table"),
      ).toBe(true)

      // Move cursor into the HTMLBlock: widget unmounts and source lines get omd-table-src
      view.dispatch({ selection: { anchor: tableFrom + 3 } })
      const editingSpecs = view.state.field(livePreviewField).specs
      expect(editingSpecs.some(s => s.tag === "widget:block:complex-table")).toBe(false)
      expect(editingSpecs.some(s => s.tag === "line:omd-table-src")).toBe(true)

      // Move cursor back to "after": widget mounts again
      view.dispatch({ selection: { anchor: COMPLEX_TABLE_DOC.length } })
      const restoredSpecs = view.state.field(livePreviewField).specs
      expect(restoredSpecs.some(s => s.tag === "widget:block:complex-table")).toBe(true)
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("keeps the widget mounted with covered overlay when selection spans across the entire block", async () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const state = EditorState.create({
      doc: COMPLEX_TABLE_DOC,
      extensions: editorExtensions(),
      selection: { anchor: COMPLEX_TABLE_DOC.length },
    })
    const view = new EditorView({ state, parent })
    try {
      forceParsing(view, COMPLEX_TABLE_DOC.length, 10000)
      drainPendingLiveBuild(view)
      view.dispatch({ selection: { anchor: 0, head: COMPLEX_TABLE_DOC.length } })
      await new Promise(resolve => setTimeout(resolve, 10))

      const specs = view.state.field(livePreviewField).specs
      expect(specs.some(s => s.tag === "widget:block:complex-table")).toBe(true)
      const wrap = view.dom.querySelector<HTMLElement>(".omd-complex-table")
      expect(wrap?.classList.contains("omd-block-covered")).toBe(true)
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("preserves equivalent widget identity across measureBlockWidget rebuilds", () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const state = EditorState.create({
      doc: COMPLEX_TABLE_DOC,
      extensions: editorExtensions(),
      selection: { anchor: COMPLEX_TABLE_DOC.length },
    })
    const view = new EditorView({ state, parent })
    try {
      forceParsing(view, COMPLEX_TABLE_DOC.length, 10000)
      drainPendingLiveBuild(view)
      const specBefore = view.state
        .field(livePreviewField)
        .specs.find(s => s.tag === "widget:block:complex-table")
      expect(specBefore).toBeTruthy()
      const widgetBefore = (specBefore!.deco.spec as { widget?: WidgetType }).widget

      view.dispatch({ effects: measureBlockWidget.of({ pos: specBefore!.from }) })

      const specAfter = view.state
        .field(livePreviewField)
        .specs.find(s => s.tag === "widget:block:complex-table")
      const widgetAfter = (specAfter!.deco.spec as { widget?: WidgetType }).widget
      expect(widgetAfter).toBe(widgetBefore)
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("lands arrow entry on the opening and closing HTMLBlock lines", () => {
    const state = makeState(COMPLEX_TABLE_DOC)
    const from = COMPLEX_TABLE_DOC.indexOf("<table>")
    const to = COMPLEX_TABLE_DOC.indexOf("</table>") + "</table>".length
    expect(blockEntryPosition(state, from, to, 1)).toBe(from)
    expect(blockEntryPosition(state, from, to, -1)).toBe(COMPLEX_TABLE_DOC.indexOf("</table>"))
  })
})
