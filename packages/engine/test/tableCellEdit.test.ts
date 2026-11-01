import { describe, expect, it } from "vitest"
import { renderEditableCell } from "../src/decorations/widgets/tableCellEdit"

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

  it("keeps a code-only cell folded when the caret sits on the opening mark", () => {
    const source = "`journal/`"
    const root = mount()
    renderEditableCell(root, source, 0)
    expect(root.querySelector("code")?.textContent).toBe("journal/")
    expect(root.textContent).not.toContain("`")
    root.remove()
  })

  it("reveals a code-only cell once the caret moves past the opening mark", () => {
    const source = "`journal/`"
    const root = mount()
    renderEditableCell(root, source, 1)
    expect(root.querySelector("code")).toBeNull()
    expect(root.textContent).toContain("`journal/`")
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
