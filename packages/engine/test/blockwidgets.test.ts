import { describe, expect, it, vi } from "vitest"
import { Decoration } from "@codemirror/view"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { BlockWidget } from "../src/decorations/blockWidget"
import { CheckboxWidget } from "../src/decorations/widgets"
import { ImageWidget, imageResolver } from "../src/decorations/widgets/image"
import { CodeWidget } from "../src/decorations/widgets/code"
import { TableWidget } from "../src/decorations/widgets/table"
import type { TableData, TableRowData } from "../src/tables/model"
import { MermaidWidget } from "../src/decorations/widgets/mermaid"
import { MathBlockWidget } from "../src/decorations/widgets/math"

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

  it("unmounts a code widget when the cursor is inside the block", () => {
    const doc = "intro\n\n```js\nconst x = 1\n```\n"
    const state = makeState(doc)
    const off = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(off).toContain("widget:block:code")
    expect(off).not.toContain("line:omd-codeblock")

    const on = state.update({ selection: { anchor: 12 } }).state
    const t = collectDecorationSpecs(on, 0, doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:code")
    expect(t).toContain("line:omd-codeblock")
  })

  it("mermaid fenced block becomes a mermaid widget, not code", () => {
    const doc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n"
    const t = collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => d.tag)
    expect(t).toContain("widget:block:mermaid")
    expect(t).not.toContain("widget:block:code")
  })

  it("unmounts a mermaid widget when the cursor is inside the block", () => {
    const doc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n"
    const state = makeState(doc)
    // 光标落在 mermaid 内容行（"graph..." 从 18 起）
    const on = state.update({ selection: { anchor: 20 } }).state
    const t = collectDecorationSpecs(on, 0, doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:mermaid")
    expect(t).toContain("line:omd-codeblock")
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
    const row = (source: string): TableRowData => ({
      from: 0, to: source.length, lineFrom: 0, lineTo: source.length,
      prefix: "", leadingPipe: true, trailingPipe: true,
      cells: [{ source, text: source, from: 0, to: source.length }],
    })
    const table: TableData = { header: row("a"), delimiter: row("---"), rows: [row("1")], aligns: [""] }
    // pos 已从 BlockWidget.eq 移除：src 相同时 DOM 可复用，click handler 用 posAtCoords 实时定位
    expect(new ProbeWidget("same", 1).eq(new ProbeWidget("same", 2))).toBe(true)   // 新行为
    expect(new ProbeWidget("a", 0).eq(new ProbeWidget("b", 0))).toBe(false)        // src 不同则不相等
    expect(new CheckboxWidget(false, 1).eq(new CheckboxWidget(false, 2))).toBe(false)
    expect(new ImageWidget("a.png", "first", "/a.png")
      .eq(new ImageWidget("a.png", "second", "/a.png"))).toBe(false)
    expect(new CodeWidget({ src: "x = 1", pos: 0, lang: "js", title: "" })
      .eq(new CodeWidget({ src: "x = 1", pos: 0, lang: "ts", title: "" }))).toBe(false)
    expect(new TableWidget("| a |\n|---|\n| 1 |", 0, table)
      .eq(new TableWidget("| a |\n|---|\n| 1 |", 0, { ...table, header: row("b") }))).toBe(false)
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

  it("installs the code placeholder before the first layout measure", () => {
    const widget = new CodeWidget({
      src: "line 1\nline 2", pos: 0, lang: "js", title: "",
    })
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    expect(dom.querySelector(".omd-block-body pre")?.textContent).toBe("line 1\nline 2")
    expect(dom.querySelector(".omd-code-copy svg")).toBeTruthy()
    expect(dom.querySelector(".omd-code-copy")?.getAttribute("aria-label")).toBe("Copy")
    dom.remove()
  })

  it("renders the block source toggle as an svg code icon, not a text glyph", () => {
    const view = { requestMeasure: () => {} } as never
    const probe = new ProbeWidget("x", 0).toDOM(view)
    const editBtn = probe.querySelector(".omd-block-edit") as HTMLElement
    expect(editBtn.querySelector("svg.omd-icon")).toBeTruthy()
    expect(editBtn.textContent).toBe("")            // ✎ 文本字形退役
    expect(editBtn.getAttribute("aria-label")).toBe("View source")
    probe.remove()
  })

  it("renders the table toolbar with svg icons and semantic labels", async () => {
    const view = { requestMeasure: () => {} } as never
    const row = (source: string): TableRowData => ({
      from: 0, to: source.length, lineFrom: 0, lineTo: source.length,
      prefix: "", leadingPipe: true, trailingPipe: true,
      cells: [{ source, text: source, from: 0, to: source.length }],
    })
    const table: TableData = { header: row("a"), delimiter: row("---"), rows: [row("1")], aligns: [""] }
    const dom = new TableWidget("| a |\n|---|\n| 1 |", 0, table).toDOM(view)
    await new Promise(resolve => setTimeout(resolve, 0))   // renderInto 走微任务
    const buttons = [...dom.querySelectorAll(".omd-table-toolbar button")] as HTMLElement[]
    expect(buttons).toHaveLength(4)
    for (const btn of buttons) {
      expect(btn.querySelector("svg.omd-icon")).toBeTruthy()
      expect(btn.textContent).toBe("")
    }
    expect(buttons.map(btn => btn.getAttribute("aria-label"))).toEqual([
      "Insert row below", "Insert column right", "Delete row", "Delete column",
    ])
    dom.remove()
  })

  it("installs async block placeholders before the first layout measure", () => {
    const view = { requestMeasure: () => {} } as never
    const math = new MathBlockWidget("$$\nx^2\n$$", 0).toDOM(view)
    const mermaid = new MermaidWidget("graph TD; A-->B", 0).toDOM(view)

    expect(math.querySelector(".omd-block-body pre")?.textContent).toBe("$$\nx^2\n$$")
    expect(mermaid.querySelector(".omd-block-body pre")?.textContent).toBe("graph TD; A-->B")
    math.remove()
    mermaid.remove()
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
    const widget = new CodeWidget({
      src: "const x = 1", pos: 0, lang: "js", title: "",
    })
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(dom.querySelector(".omd-block-body")?.innerHTML).toContain("--shiki-dark")
    dom.remove()
  })

  // 空行契约：Shiki 对空行输出 <span class="line"></span>（无任何子节点）。
  // display:block 的空元素高度为 0 —— 空行会整行消失（用户实测"渲染时空行被
  // 取消"）。CSS 侧必须给 .line:empty 提供行框（::after 零宽空格），桌面
  // blockWidgetLayout 漂移测试守护该规则。
  it("keeps blank lines as empty .line spans the CSS must prop open", async () => {
    const widget = new CodeWidget({
      src: "const a = 1\n\nconst b = 2", pos: 0, lang: "js", title: "",
    })
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    document.body.appendChild(dom)
    await new Promise(resolve => setTimeout(resolve, 400))
    const lines = [...dom.querySelectorAll(".omd-code-lines .line")]
    expect(lines.length).toBe(3)
    expect(lines[1].childElementCount).toBe(0)
    expect(lines[1].textContent).toBe("")
    dom.remove()
  }, 2000)

  it("does not move the editor selection when clicking a rendered code row", () => {
    let anchor = -1
    const view = {
      requestMeasure: () => {},
      posAtCoords: () => 9999,
      dispatch: ({ selection }: { selection?: { anchor: number } }) => {
        if (selection) anchor = selection.anchor
      },
      focus: () => {},
    }
    const widget = new CodeWidget({
      src: "line 1\nline 2\nline 3", pos: 0, lang: "js", title: "",
    })
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
    expect(anchor).toBe(-1)
  })

  it("does not dispatch selection when a code block moves under the pointer", () => {
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
    const widget = new CodeWidget({
      src: "line 1\nline 2", pos: 0, lang: "js", title: "",
    })
    const dom = widget.toDOM(view as never)
    const body = dom.querySelector(".omd-block-body") as HTMLElement
    body.innerHTML = "<pre><code><span class='line'>line 1</span><span class='line'>line 2</span></code></pre>"
    wrap.appendChild(dom)
    ;(body.querySelectorAll(".line")[1] as HTMLElement).dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
    }))
    expect(anchor).toBe(-1)
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

  it("keeps source placeholder without writing Mermaid output after destroy", async () => {
    const widget = new MermaidWidget("graph TD; A-->B", 0)
    const dom = widget.toDOM({ requestMeasure: () => {} } as never)
    widget.destroy(dom)
    await new Promise(resolve => setTimeout(resolve, 600))
    // 编辑按钮自带 svg.omd-icon，这里只断言 mermaid 渲染输出未写入
    expect(dom.querySelector("svg.omd-mermaid-svg")).toBeNull()
    expect(dom.querySelector(".omd-block-body")?.textContent).toBe("graph TD; A-->B")
  }, 2000)
})
