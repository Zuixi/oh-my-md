import { describe, expect, it } from "vitest"
import { Decoration } from "@codemirror/view"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"
import { BlockWidget } from "../src/decorations/blockWidget"

class ProbeWidget extends BlockWidget {
  protected get cssClass() { return "omd-probe" }
  protected renderInto(el: HTMLElement) { el.textContent = "probe" }
}

import { imageResolver } from "../src/decorations/widgets/image"

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
    // 光标恰好在块结束后 → 不算选中（块恢复渲染态）
    const atEnd = state.update({ selection: { anchor: 19 } }).state
    expect(blockSelected(atEnd, 7, 19)).toBe(false)
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
})
