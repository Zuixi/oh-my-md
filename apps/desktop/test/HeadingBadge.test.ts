import { describe, expect, it, vi } from "vitest"
import { createEditor, type CreateEditorOptions } from "../src/Editor"

// 光标所在标题行的级别徽标契约（engine inline.ts 的 omd-h-active line class +
// data-omd-h 属性 → styles.css 的 ::before 徽标）。Editor.test.ts 已达模块尺寸
// 硬上限，徽标用例落在这个同胞文件。
// 原用例的 editorOptions(vi.fn(), doc) 双参形态：首参 onDocumentUpdate 已内置。
function editorOptions(_onUpdate: unknown, doc: string): CreateEditorOptions {
  return {
    doc,
    tabId: 7,
    documentId: 11,
    getDocPath: () => null,
    getDocumentId: () => 11,
    onDocumentUpdate: vi.fn(),
    onError: vi.fn(),
  }
}

describe("heading level badge (live preview)", () => {
  const mount = (doc: string) => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = createEditor(parent, editorOptions(vi.fn(), doc))
    return { view, parent }
  }

  it("badges the heading line while the cursor is inside it and clears it on leave", () => {
    const { view, parent } = mount("# 一级\n\nbody")
    try {
      view.dispatch({ selection: { anchor: 3 } })  // cursor inside the heading text
      const active = parent.querySelector(".cm-line.omd-h-active")
      expect(active?.getAttribute("data-omd-h")).toBe("1")

      view.dispatch({ selection: { anchor: "# 一级\n\nbody".length } })  // cursor on body
      expect(parent.querySelector(".cm-line.omd-h-active")).toBeNull()
      expect(parent.querySelector(".cm-line.omd-h1")?.getAttribute("data-omd-h")).toBeNull()
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("badges h6 and setext headings with their real level", () => {
    const { view, parent } = mount("###### 六级\nTitle\n-----")
    try {
      view.dispatch({ selection: { anchor: 4 } })
      expect(parent.querySelector(".cm-line.omd-h-active")?.getAttribute("data-omd-h")).toBe("6")
      view.dispatch({ selection: { anchor: "###### 六级\nTitle\n-----".length - 5 } })  // setext title text
      const setext = parent.querySelector(".cm-line.omd-h2.omd-h-active")
      expect(setext?.getAttribute("data-omd-h")).toBe("2")
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

