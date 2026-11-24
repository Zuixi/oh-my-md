import { describe, expect, it } from "vitest"
import { cellSourceOffsetAt, renderEditableCell } from "../src/decorations/widgets/tableCellEdit"

const CODE = "use `code` here"
const LINK = "see [a](https://e.test)"

function mount(): HTMLElement {
  const root = document.createElement("div")
  document.body.appendChild(root)
  return root
}

describe("renderEditableCell", () => {
  it("keeps inline code folded at the node's start and inside the code text", () => {
    const source = "`journal/`"
    const root = mount()
    const middle = source.indexOf("journal/") + Math.floor("journal/".length / 2)
    for (const caret of [0, middle]) {
      renderEditableCell(root, source, caret)
      expect(root.querySelector("code")?.textContent).toBe("journal/")
      expect(root.textContent).not.toContain("`")
    }
    root.remove()
  })

  it("returns the folded code content offset when the hit has no layout", () => {
    const source = "use `code` here"
    const root = mount()
    renderEditableCell(root, source, 0)
    const span = root.querySelector<HTMLElement>("code [data-from]")
    const contentFrom = source.indexOf("`") + 1
    expect(span?.textContent).toBe("code")
    expect(Number(span?.dataset.from)).toBe(contentFrom)
    const original = document.elementFromPoint.bind(document)
    document.elementFromPoint = () => span
    span!.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
    expect(cellSourceOffsetAt(root, 4, 4)).toBe(contentFrom)
    document.elementFromPoint = original
    root.remove()
  })

  it("keeps inline code folded when the caret is in the surrounding text", () => {
    const root = mount()
    renderEditableCell(root, CODE, CODE.indexOf("use") + 1)
    expect(root.querySelectorAll("code")).toHaveLength(1)
    expect(root.querySelector("code")?.textContent).toBe("code")
    root.remove()
  })

  it("projects <br>/<hr> tags as elements while editing on either side, and reveals raw source only strictly inside the tag", () => {
    const root = mount()
    const source = "a<br>b<hr>c"
    // At boundary offsets (`a|<br>b` = 1 and `a<br>|b` = 5), `<br>`/`<hr>` remain elements.
    for (const caret of [0, 1, 5, 6, 10, source.length]) {
      renderEditableCell(root, source, caret)
      expect(root.querySelector("br")).toBeTruthy()
      expect(root.querySelector("hr")).toBeTruthy()
      expect(root.querySelector(".omd-table-caret")).toBeTruthy()
      expect(root.textContent).toBe("abc")
    }
    // Stepping strictly inside `<br>` (`a<|br>b` = 2) unfolds `<br>` into editable text
    // with the caret placed inside it instead of destroying the `<br>` void element.
    renderEditableCell(root, source, 2)
    expect(root.querySelector("br")).toBeNull()
    expect(root.querySelector("hr")).toBeTruthy()
    expect(root.textContent).toBe("a<br>bc")
    expect(root.querySelector(".omd-table-caret")?.previousSibling?.textContent).toBe("<")
    expect(root.querySelector(".omd-table-caret")?.nextSibling?.textContent).toBe("br>")
    root.remove()
  })

  it("keeps emphasis folded with the markers hidden", () => {
    const root = mount()
    renderEditableCell(root, "**bold**", 3)
    expect(root.querySelector("strong")?.textContent).toBe("bold")
    expect(root.textContent).not.toContain("*")
    root.remove()
  })

  it("reveals the whole link when the caret is inside it", () => {
    const root = mount()
    renderEditableCell(root, LINK, LINK.indexOf("[a]") + 1)
    expect(root.textContent).toContain("[a](https://e.test)")
    expect(root.querySelector("a")).toBeNull()
    root.remove()
  })

  it("renders a folded link when the caret is in the surrounding text", () => {
    const root = mount()
    renderEditableCell(root, LINK, LINK.indexOf("see") + 1)
    expect(root.querySelectorAll("a.omd-link")).toHaveLength(1)
    expect(root.querySelector("a.omd-link")?.textContent).toBe("a")
    root.remove()
  })
})
