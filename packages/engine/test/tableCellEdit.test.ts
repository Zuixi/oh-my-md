import { describe, expect, it } from "vitest"
import { cellSourceOffsetAt, renderEditableCell, unhitClickCaret } from "../src/decorations/widgets/tableCellEdit"

const CODE = "use `code` here"
const LINK = "see [a](https://e.test)"

function mount(): HTMLElement {
  const root = document.createElement("div")
  document.body.appendChild(root)
  return root
}

describe("renderEditableCell", () => {
  it("reveals the whole inline code node when the caret is inside it", () => {
    const root = mount()
    renderEditableCell(root, CODE, CODE.indexOf("code"))
    expect(root.querySelector("code")).toBeNull()
    expect(root.textContent).toContain("`")
    root.remove()
  })

  it("reveals raw source when the caret equals the inline code node's start", () => {
    const source = "`journal/`"
    const root = mount()
    renderEditableCell(root, source, 0)
    expect(root.querySelector("code")).toBeNull()
    expect(root.textContent).toContain("`journal/`")
    root.remove()
  })

  it("reveals raw source when the caret is one past the opening mark", () => {
    const source = "`journal/`"
    const root = mount()
    renderEditableCell(root, source, 1)
    expect(root.querySelector("code")).toBeNull()
    expect(root.textContent).toContain("`journal/`")
    root.remove()
  })

  it("renders the code chip for an unhit click and stamps the visible text inside the content", () => {
    const source = "`journal/`"
    const root = mount()
    const caret = unhitClickCaret(source)
    expect(caret).toBe(source.length)
    renderEditableCell(root, source, caret)
    const code = root.querySelector("code")
    expect(code?.textContent).toBe("journal/")
    expect(code?.textContent).not.toContain("`")
    const span = code?.querySelector<HTMLElement>("[data-from]")
    expect(Number(span?.dataset.from)).toBe(1)
    expect(Number(span?.dataset.to)).toBe(source.length - 1)
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
