import { describe, expect, it } from "vitest"
import { Decoration } from "@codemirror/view"
import { BlockWidget } from "../src/decorations/blockWidget"

class ProbeWidget extends BlockWidget {
  protected get cssClass() { return "omd-probe" }
  protected renderInto(el: HTMLElement) { el.textContent = "probe" }
}

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

  it("widget decorations are atomic ranges spec-able (sanity: replace deco exists)", () => {
    const deco = Decoration.replace({ widget: new ProbeWidget("x", 0), block: true })
    expect(deco).toBeTruthy()
  })
})
