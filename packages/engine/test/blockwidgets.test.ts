import { describe, expect, it, vi } from "vitest"
import { Decoration } from "@codemirror/view"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { BlockWidget } from "../src/decorations/blockWidget"
import { CheckboxWidget } from "../src/decorations/widgets"
import { ImageWidget, imageResolver } from "../src/decorations/widgets/image"
import { CodeWidget } from "../src/decorations/widgets/code"
import { TableWidget, type TableData } from "../src/decorations/widgets/table"
import { MermaidWidget } from "../src/decorations/widgets/mermaid"

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (_id: string, src: string) => ({
      svg: `<svg class="omd-mermaid-svg"><text>${src}</text></svg>`,
    }),
  },
}))

class ProbeWidget extends BlockWidget {
  protected get cssClass() { return "omd-probe" }
  protected renderInto(el: HTMLElement) { el.textContent = "probe" }
}

class RejectedWidget extends BlockWidget {
  protected get cssClass() { return "omd-rejected" }
  protected async renderInto() {
    await new Promise(resolve => setTimeout(resolve, 10))
    throw new Error("late failure")
  }
}

class ResolvedWidget extends BlockWidget {
  protected get cssClass() { return "omd-resolved" }
  protected async renderInto(el: HTMLElement) {
    await Promise.resolve()
    el.textContent = "done"
  }
}

const imageResolverTestFacet = imageResolver.of((s: string) => `/resolved/${s}`)

describe("block widget pipeline", () => {
  it("blockSelected strict-overlap logic", async () => {
    const { blockSelected } = await import("../src/decorations/blockWidget")
    const { makeState } = await import("./helpers")
    const state = makeState("before\n\n```\ncode\n```\n\nafter")
    // 光标在 before（pos 0）→ 代码块未选中
    expect(blockSelected(state, 7, 19)).toBe(false)
    const inside = state.update({ selection: { anchor: 10 } }).state
    expect(blockSelected(inside, 7, 19)).toBe(true)
    // 光标恰在块结束边界 → 仍算块内（打字到块尾不被 widget 吞掉；彻底离开才渲染）
    const atEnd = state.update({ selection: { anchor: 19 } }).state
    expect(blockSelected(atEnd, 7, 19)).toBe(true)
    // 光标越过边界 → 块恢复渲染态
    const past = state.update({ selection: { anchor: 21 } }).state
    expect(blockSelected(past, 7, 19)).toBe(false)
    // 完整包含（Cmd+A / 跨块拖选 / Shift+↓ 跨块）→ 保持渲染，不显源码
    const selectAll = state.update({ selection: { anchor: 0, head: 26 } }).state
    expect(blockSelected(selectAll, 7, 19)).toBe(false)
    const cover = state.update({ selection: { anchor: 0, head: 20 } }).state
    expect(blockSelected(cover, 7, 19)).toBe(false)
    const exactCover = state.update({ selection: { anchor: 7, head: 19 } }).state
    expect(blockSelected(exactCover, 7, 19)).toBe(false)
    // 部分重叠（选区一端扎进块内）→ 编辑意图，显源码
    const partial = state.update({ selection: { anchor: 7, head: 18 } }).state
    expect(blockSelected(partial, 7, 19)).toBe(true)
    const partialEnd = state.update({ selection: { anchor: 10, head: 25 } }).state
    expect(blockSelected(partialEnd, 7, 19)).toBe(true)
  })

  it("fenced code becomes a code widget off-cursor, line styles on-cursor", () => {
    const doc = "intro\n\n```js\nconst x = 1\n```\n"
    const state = makeState(doc)
    const off = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(off).toContain("widget:block:code")
    expect(off).not.toContain("line:omd-codeblock")

    const on = state.update({ selection: { anchor: 12 } }).state
    const t = collectDecorationSpecs(on, 0, doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:code")
    expect(t).toContain("line:omd-codeblock")  // 编辑态退回 M1 行样式
  })

  it("mermaid fenced block becomes a mermaid widget, not code", () => {
    const doc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n"
    const t = collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => d.tag)
    expect(t).toContain("widget:block:mermaid")
    expect(t).not.toContain("widget:block:code")
  })

  it("image becomes inline widget off-cursor, resolves src via facet", () => {
    const doc = "intro\n\n![alt](assets/pic.png)"
    const state = makeState(doc, [imageResolverTestFacet])
    const t = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(t).toContain("widget:image")
  })

  it("widget decorations are atomic ranges spec-able (sanity: replace deco exists)", () => {
    const deco = Decoration.replace({ widget: new ProbeWidget("x", 0), block: true })
    expect(deco).toBeTruthy()
  })

  it("widget equality includes every DOM behavior input", () => {
    const table: TableData = { header: ["a"], rows: [["1"]], aligns: [""] }
    // pos 已从 BlockWidget.eq 移除：src 相同时 DOM 可复用，click handler 用 posAtCoords 实时定位
    expect(new ProbeWidget("same", 1).eq(new ProbeWidget("same", 2))).toBe(true)   // 新行为
    expect(new ProbeWidget("a", 0).eq(new ProbeWidget("b", 0))).toBe(false)        // src 不同则不相等
    expect(new CheckboxWidget(false, 1).eq(new CheckboxWidget(false, 2))).toBe(false)
    expect(new ImageWidget("a.png", "first", "/a.png")
      .eq(new ImageWidget("a.png", "second", "/a.png"))).toBe(false)
    expect(new CodeWidget("x = 1", 0, "js").eq(new CodeWidget("x = 1", 0, "ts"))).toBe(false)
    expect(new TableWidget("| a |\n|---|\n| 1 |", 0, table)
      .eq(new TableWidget("| a |\n|---|\n| 1 |", 0, { ...table, header: ["b"] }))).toBe(false)
  })

  it("does not write an async fallback into detached DOM", async () => {
    const widget = new RejectedWidget("source", 0)
    const dom = widget.toDOM({} as never)
    document.body.appendChild(dom)
    widget.destroy(dom)
    dom.remove()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(dom.querySelector(".omd-block-body")?.textContent).toBe("")
  })

  it("finishes rendering before an editor root is attached", async () => {
    const widget = new RejectedWidget("source", 0)
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(dom.querySelector(".omd-block-body")?.textContent).toContain("late failure")
  })

  it("requests a layout measure after async block rendering", async () => {
    let measures = 0
    const widget = new ResolvedWidget("source", 0)
    const dom = widget.toDOM({ requestMeasure: () => { measures++ } } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(measures).toBe(1)
    dom.remove()
  })

  it("requests a layout measure after rendering an error fallback", async () => {
    let measures = 0
    const widget = new RejectedWidget("source", 0)
    const dom = widget.toDOM({ requestMeasure: () => { measures++ } } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(measures).toBe(1)
    dom.remove()
  })

  it("maps fenced-code language aliases and rejects unknown languages", async () => {
    const { resolveCodeLanguage } = await import("../src/shiki/languages")
    expect(resolveCodeLanguage("JS")).toBe("javascript")
    expect(resolveCodeLanguage("ts")).toBe("typescript")
    expect(resolveCodeLanguage("unknown-language")).toBe(null)
  })

  it("renders code with dual-theme dark CSS variables", async () => {
    const widget = new CodeWidget("const x = 1", 0, "js")
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(dom.querySelector(".omd-block-body")?.innerHTML).toContain("--shiki-dark")
    dom.remove()
  }, 2000)

  it("maps code-widget clicks to the clicked source line", () => {
    let anchor = -1
    const view = {
      requestMeasure: () => {},
      posAtCoords: () => 9999,
      dispatch: ({ selection }: { selection?: { anchor: number } }) => {
        if (selection) anchor = selection.anchor
      },
      focus: () => {},
    }
    const widget = new CodeWidget("line 1\nline 2\nline 3", 0, "js", 100, 117)
    const dom = widget.toDOM(view as never)
    const body = dom.querySelector(".omd-block-body") as HTMLElement
    body.innerHTML = "<pre><code><span class='line'>line 1</span><span class='line'>line 2</span><span class='line'>line 3</span></code></pre>"
    const firstLine = body.querySelector(".line") as HTMLElement
    firstLine.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    }))
    expect(anchor).toBe(100)
  })

  it("recomputes code source position after the block moves", () => {
    let anchor = -1
    const wrap = document.createElement("div")
    const view = {
      requestMeasure: () => {},
      posAtCoords: () => 9999,
      posAtDOM: () => 50,
      state: { doc: { length: 200, lineAt: (pos: number) => ({ to: pos + 9 }) } },
      dispatch: ({ selection }: { selection?: { anchor: number } }) => {
        if (selection) anchor = selection.anchor
      },
      focus: () => {},
    }
    const widget = new CodeWidget("line 1\nline 2", 0, "js", 0, 13)
    const dom = widget.toDOM(view as never)
    const body = dom.querySelector(".omd-block-body") as HTMLElement
    body.innerHTML = "<pre><code><span class='line'>line 1</span><span class='line'>line 2</span></code></pre>"
    wrap.appendChild(dom)
    ;(body.querySelectorAll(".line")[1] as HTMLElement).dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
    }))
    expect(anchor).toBe(67)
  })

  it("writes mermaid SVG into the widget body", async () => {
    const widget = new MermaidWidget("graph TD; A-->B", 0)
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(dom.querySelector("svg.omd-mermaid-svg")).toBeTruthy()
    expect(dom.querySelector(".omd-block-body")?.textContent).toContain("graph TD; A-->B")
    dom.remove()
  }, 2000)

  it("does not write mermaid SVG after destroy", async () => {
    const widget = new MermaidWidget("graph TD; A-->B", 0)
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    widget.destroy(dom)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(dom.querySelector("svg")).toBeNull()
    expect(dom.querySelector(".omd-block-body")?.textContent).toBe("")
  }, 2000)
})
