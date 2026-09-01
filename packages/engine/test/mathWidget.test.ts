import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { MathBlockWidget, mathTexOf, rebuildMathSrc } from "../src/decorations/widgets/math"

// MathBlockWidget's base imports the live decoration field, which is irrelevant to these tests.
vi.mock("../src/decorations/build", () => ({
  livePreviewField: {},
}))

const tick = (ms = 150) => new Promise(r => setTimeout(r, ms))

describe("math source helpers", () => {
  it("extracts tex from single-line and multi-line blocks", () => {
    expect(mathTexOf("$$x+y$$")).toBe("x+y")
    expect(mathTexOf("$$\na = b\n$$")).toBe("a = b")
    expect(mathTexOf("$$ x $$")).toBe("x")
  })

  it("rebuilds preserving the original delimiter shape", () => {
    expect(rebuildMathSrc("$$a$$", "b+c")).toBe("$$b+c$$")
    expect(rebuildMathSrc("$$\na\n$$", "b\nc")).toBe("$$\nb\nc\n$$")
    // 单行形态收到多行草稿时保留单行包裹（Lezer 仍解析为 MathBlock）
    expect(rebuildMathSrc("$$a$$", "b\nc")).toBe("$$b\nc$$")
  })
})

describe("MathBlockWidget widget-reuse contract", () => {
  // CM findWidget pass 0 reuses tiles whose compare/eq succeeds WITHOUT calling
  // updateDOM; updateDOM only runs in pass 1 for widgets whose eq FAILED. So eq
  // must return false whenever src changed, otherwise the KaTeX preview would
  // never re-render during per-keystroke write-back.
  it("eq compares src and embed", () => {
    const a = new MathBlockWidget("$$a$$", 0)
    expect(a.eq(new MathBlockWidget("$$a$$", 7))).toBe(true)   // pos 不参与
    expect(a.eq(new MathBlockWidget("$$totally different$$", 0))).toBe(false)
    const nested = new MathBlockWidget("$$a$$", 0, { quoteDepth: 1, listDepth: 0, quoteInList: false })
    expect(a.eq(nested)).toBe(false)
  })

  it("eq never matches across widget types", () => {
    const a = new MathBlockWidget("$$a$$", 0)
    const duck = { src: "$$a$$", embed: a.embed } as unknown as MathBlockWidget
    expect(a.eq(duck)).toBe(false)
  })

  it("updateDOM syncs the textarea even while focused and re-renders the preview", async () => {
    const w = new MathBlockWidget("$$\nnew\n$$", 0)
    const wrap = document.createElement("div")
    wrap.className = "omd-block omd-math"
    const body = document.createElement("div")
    body.className = "omd-block-body"
    const popup = document.createElement("div")
    popup.className = "omd-math-popup"
    const ta = document.createElement("textarea")
    ta.className = "omd-math-editor"
    ta.value = "stale"
    popup.appendChild(ta)
    wrap.appendChild(body)
    wrap.appendChild(popup)
    document.body.appendChild(wrap)
    ta.focus()   // 焦点在输入框内也必须同步（Undo/Redo、外部编辑场景）

    const view = { requestMeasure: () => {} } as unknown as EditorView
    expect(w.updateDOM(wrap, view, w)).toBe(true)
    expect(ta.value).toBe("new")

    await tick()   // rAF + async KaTeX render
    expect(body.querySelector("annotation")?.textContent).toBe("new")
    wrap.remove()
  })
})
