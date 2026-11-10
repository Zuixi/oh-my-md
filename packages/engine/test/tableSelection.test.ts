import { forceParsing } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it } from "vitest"
import { drainPendingLiveBuild } from "../src/decorations/build"
import { renderTableCellContent } from "../src/decorations/widgets/tableCell"
import {
  cellVisibleSourceOffset,
  renderedCellSourceOffset,
  tableCellSlotAt,
  TABLE_POINTER_DRIFT_PX,
} from "../src/decorations/widgets/tableSelection"
import { editorExtensions } from "../src/index"
import { getTableEditSession } from "../src/tables/directEdit"
import { tableAt } from "../src/tables/navigate"

const TABLE = "| **A** | B |\n| --- | --- |\n| 1 | 2 |"

/** Visible text as the shared cell projection produces it (no layout needed). */
function projected(source: string): string {
  const root = document.createElement("div")
  renderTableCellContent(root, source)
  return root.textContent ?? ""
}

const fromTable = (row: number, column: number) => ({
  row,
  column,
  source: "",
  text: "",
  from: 0,
  to: 0,
})

describe("cellVisibleSourceOffset", () => {
  // Rendered text folds Markdown, so a rendered press can only map onto the source bytes
  // that produced the glyph under the pointer. These are the real boundaries it must pick.
  const cases: {
    readonly name: string
    readonly source: string
    readonly visible?: string
    readonly expected: readonly (readonly [number, number])[]
  }[] = [
    {
      name: "strong markup",
      source: "**bold**",
      expected: [[0, 2], [1, 3], [4, 6]],
    },
    {
      // The closing backtick sits between the rendered `code` and the following space, so
      // every boundary past the code span lands one byte later than the visible column.
      name: "inline code",
      source: "use `code` here",
      expected: [[0, 0], [4, 4], [8, 9], [11, 13]],
    },
    {
      name: "link label",
      source: "[label](https://e.test)",
      expected: [[0, 1], [5, 6]],
    },
    {
      name: "escaped pipe",
      source: "a\\|b",
      expected: [[0, 0], [1, 1], [2, 3], [3, 4]],
    },
    {
      name: "html entity",
      source: "x &amp; y",
      expected: [[0, 0], [2, 2], [3, 3], [5, 9]],
    },
    {
      name: "surrogate pair stays one glyph",
      source: "😀x",
      expected: [[0, 0], [2, 2], [3, 3]],
    },
    {
      name: "image-only cell has no visible glyph to anchor",
      source: "![alt](x)",
      expected: [[0, 0]],
    },
    {
      // The emoji resolves to a code point the source never spells: the shortcode is skipped
      // instead of ending the alignment, so a drag past it still copies real source bytes.
      name: "emoji shortcode the source cannot spell",
      source: ":smile: x",
      expected: [[0, 7], [2, 7], [3, 8], [4, 9]],
    },
  ]

  for (const { name, source, visible, expected } of cases) {
    it(`maps ${name} onto real source boundaries`, () => {
      const text = visible ?? projected(source)
      for (const [index, offset] of expected) {
        expect([name, index, cellVisibleSourceOffset(source, text, index)])
          .toEqual([name, index, offset])
      }
    })
  }

  it("never invents offsets past the source it could align", () => {
    // Visible text the source cannot fully match (projection-only glyphs) stops at the last
    // real boundary instead of guessing an in-range index.
    expect(cellVisibleSourceOffset("**bo", "bold", 4)).toBe(4)
    expect(cellVisibleSourceOffset("", "bold", 2)).toBe(0)
    expect(cellVisibleSourceOffset("**bold**", "bold", 99)).toBe(6)
    expect(cellVisibleSourceOffset("**bold**", "bold", -3)).toBe(2)
  })

  it("keeps every selected slice a substring of the cell source", () => {
    const source = "a **bold** and \\| tail"
    const text = projected(source)
    for (let start = 0; start <= text.length; start++) {
      for (let end = start; end <= text.length; end++) {
        const from = cellVisibleSourceOffset(source, text, start)
        const to = cellVisibleSourceOffset(source, text, end)
        expect(from).toBeLessThanOrEqual(to)
        expect(source.slice(from, to).length).toBe(to - from)
      }
    }
  })
})

describe("renderedCellSourceOffset", () => {
  const original = document.caretPositionFromPoint

  afterEach(() => {
    document.caretPositionFromPoint = original
  })

  function stubCaret(node: Node, offset: number): void {
    document.caretPositionFromPoint = () => ({ offsetNode: node, offset, getClientRect: () => new DOMRect() })
  }

  it("maps a rendered press through the visible text prefix", () => {
    const cell = document.createElement("td")
    renderTableCellContent(cell, "**bold**")
    const text = cell.firstChild?.firstChild
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("expected the projected text node")
    stubCaret(text, 2)
    // Visible offset 2 ends the "bo" run, i.e. source index 4 inside `**bold**`.
    expect(renderedCellSourceOffset({ ...fromTable(1, 0), source: "**bold**" }, cell, 0, 0)).toBe(4)
  })

  it("falls back to the nearer cell edge when the pointer has no rendered column", () => {
    const cell = document.createElement("td")
    renderTableCellContent(cell, "**bold**")
    stubCaret(document.body, 0)
    cell.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20)
    const model = { ...fromTable(1, 0), source: "**bold**" }
    expect(renderedCellSourceOffset(model, cell, 10, 10)).toBe(2)
    expect(renderedCellSourceOffset(model, cell, 90, 10)).toBe(6)
  })
})

/** The widget renders its table asynchronously (see BlockWidget.renderInto). */
async function renderedCell(view: EditorView, selector: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const hit = view.dom.querySelector<HTMLElement>(selector)
    if (hit) return hit
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`expected a rendered ${selector}`)
}

function mount(doc: string, extensions: readonly Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [editorExtensions({ experimentalTableDirectEdit: true }), ...extensions],
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  drainPendingLiveBuild(view)
  return { view, cleanup: () => { view.destroy(); parent.remove() } }
}

function press(target: HTMLElement, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, button: 0, clientX, clientY,
  }))
}

function move(clientX: number, clientY: number): void {
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }))
}

function release(): void {
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
}

describe("table pointer gestures", () => {
  it("a press without travel keeps the cell session and drops its listeners", async () => {
    const { view, cleanup } = mount(TABLE)
    const cell = await renderedCell(view, ".omd-table td")
    press(cell, 10, 10)
    const input = view.dom.querySelector(".omd-table-cell-input")
    expect(input).not.toBeNull()
    expect(getTableEditSession(view.state)).not.toBeNull()
    release()
    // Released gestures are gone: a late move cannot rewrite the selection behind the input.
    move(400, 400)
    expect(view.dom.querySelector(".omd-table-cell-input")).toBe(input)
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.doc.toString()).toBe(TABLE)
    cleanup()
  })

  it("read-only presses never open a cell session but still commit a source anchor", async () => {
    const { view, cleanup } = mount(TABLE, [EditorState.readOnly.of(true)])
    const cell = await renderedCell(view, ".omd-table thead th")
    const table = tableAt(view.state, 0)
    if (!table) throw new Error("expected table data")
    press(cell, 10, 10)
    expect(view.dom.querySelector(".omd-table-cell-input")).toBeNull()
    expect(getTableEditSession(view.state)).toBeNull()
    // A read-only press alone stays a click, so the gesture has to travel past the drift
    // threshold before it commits the cell's source anchor.
    move(10 + TABLE_POINTER_DRIFT_PX + 1, 10)
    release()
    const head = view.state.selection.main.head
    const headerCell = table.data.header.cells[0]
    if (!headerCell) throw new Error("expected a header cell")
    // No layout in this DOM: the anchor is still a real source boundary of the pressed cell.
    expect(head).toBeGreaterThanOrEqual(table.from + headerCell.from)
    expect(head).toBeLessThanOrEqual(table.from + headerCell.to)
    expect(view.state.doc.toString()).toBe(TABLE)
    expect(view.dom.querySelector(".omd-table-src")).not.toBeNull()
    cleanup()
  })

  it("reports the source slot a rendered cell shows", async () => {
    const { view, cleanup } = mount(TABLE)
    await renderedCell(view, ".omd-table td")
    const cells = view.dom.querySelectorAll<HTMLElement>(".omd-table th, .omd-table td")
    expect(cells.length).toBe(4)
    expect(tableCellSlotAt(cells[0])).toMatchObject({ row: 0, column: 0 })
    expect(tableCellSlotAt(cells[3])).toMatchObject({ row: 1, column: 1 })
    expect(tableCellSlotAt(null)).toBeNull()
    expect(tableCellSlotAt(document.body)).toBeNull()
    cleanup()
  })

  it("anchors an editable cell press on the rendered glyph before opening the cell projection", async () => {
    const doc = "| &hellip;hello | B |\n| --- | --- |\n| 1 | 2 |"
    const { view, cleanup } = mount(doc)
    const cell = await renderedCell(view, ".omd-table thead th")
    const original = document.elementFromPoint.bind(document)
    let hitFirstText = ""
    document.elementFromPoint = (x, y) => {
      const spans = cell.querySelectorAll<HTMLElement>(".omd-table-cell-view [data-from]")
      if (spans.length >= 2) {
        hitFirstText = spans[0].textContent ?? ""
        spans[1].getBoundingClientRect = () => new DOMRect(10, 0, 50, 20)
        return spans[1]
      }
      return original(x, y)
    }
    try {
      press(cell, 10, 10)
      move(10 + TABLE_POINTER_DRIFT_PX + 1, 10)
      release()
      expect(hitFirstText).toBe("\u2026")
      expect(view.state.selection.main.anchor).toBe(doc.indexOf("hello"))
    } finally {
      document.elementFromPoint = original
      cleanup()
    }
  })
})


describe("cellVisibleSourceOffset markup shadowing", () => {
  // red-before-fix: the per-glyph `indexOf` search matched the visible letters inside the
  // entity name, so pressing at the start of `…hello` anchored on source index 1 and a drag
  // to the cell end copied `hellip;hello` instead of the text the user saw.
  it("maps text after an entity onto the literal text, not the entity name", () => {
    const source = "&hellip;hello"
    const text = projected(source)
    expect(text).toBe("\u2026hello")
    const mapped = [...Array(text.length + 1).keys()]
      .map(index => cellVisibleSourceOffset(source, text, index))
    expect(mapped).toEqual([8, 8, 9, 10, 11, 12, 13])
    expect(source.slice(mapped[0], mapped[mapped.length - 1])).toBe("hello")
  })

  it("maps text after an emoji shortcode onto the literal text", () => {
    const source = ":smile:smile"
    const text = projected(source)
    // The shortcode renders as one non-BMP glyph: two UTF-16 columns before the word.
    expect(text.length).toBe(7)
    const mapped = [...Array(text.length + 1).keys()]
      .map(index => cellVisibleSourceOffset(source, text, index))
    expect(mapped).toEqual([7, 7, 7, 8, 9, 10, 11, 12])
    expect(source.slice(mapped[2], mapped[7])).toBe("smile")
  })

  it("still anchors a literal entity glyph on its own byte", () => {
    // `&` is what `&amp;` renders: the entity start is a real visible glyph boundary.
    expect(cellVisibleSourceOffset("x &amp; y", "x & y", 2)).toBe(2)
    expect(cellVisibleSourceOffset("x &amp; y", "x & y", 3)).toBe(3)
  })

  it("does not match visible text inside hidden link URLs, image alt text, html tags, or leading shortcode colons", () => {
    expect(cellVisibleSourceOffset("<u>u</u>x", projected("<u>u</u>x"), 0)).toBe(3)
    expect(cellVisibleSourceOffset("<kbd>k</kbd>x", projected("<kbd>k</kbd>x"), 0)).toBe(5)
    expect(cellVisibleSourceOffset("<br>b", projected("<br>b"), 0)).toBe(4)
    expect(cellVisibleSourceOffset("a<br>b", projected("a<br>b"), 2)).toBe(6)
    expect(cellVisibleSourceOffset("[go](https://e.test/target)target", projected("[go](https://e.test/target)target"), 3)).toBe(28)
    expect(cellVisibleSourceOffset("![alt](https://e.test/a.png)alt", projected("![alt](https://e.test/a.png)alt"), 0)).toBe(28)
    expect(cellVisibleSourceOffset(":smile::x", projected(":smile::x"), 2)).toBe(7)
    expect(cellVisibleSourceOffset("&lt;&", projected("&lt;&"), 1)).toBe(4)
  })
})
