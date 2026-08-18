import { describe, expect, it } from "vitest"
import { EditorState, RangeSetBuilder } from "@codemirror/state"
import { Decoration, EditorView } from "@codemirror/view"
import { editorExtensions, setBlockRenderBudget } from "../src/index"
import { BlockWidget } from "../src/decorations/blockWidget"

class MarkerWidget extends BlockWidget {
  static readonly rendered: MarkerWidget[] = []
  protected get cssClass() { return "omd-marker" }
  protected renderInto(el: HTMLElement) { MarkerWidget.rendered.push(this); el.textContent = "rendered" }
}

function lineStartOf(doc: string, line: number): number {
  return line === 0 ? 0 : doc.split("\n").slice(0, line).join("\n").length + 1
}

/** 每块占 1 行（`block i`），块间隔 3 行空行 → 块 i 在行 i*4。 */
function viewWithMarkers(blocks: number, cursorLine: number): EditorView {
  const lines: string[] = []
  for (let i = 0; i < blocks; i++) lines.push(`block ${i}`, "", "", "")
  const doc = lines.join("\n")
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 0; i < blocks; i++) {
    const from = lineStartOf(doc, i * 4)
    const to = from + `block ${i}`.length   // 整行 replace，满足 block 对齐
    builder.add(from, to, Decoration.replace({ widget: new MarkerWidget(`block ${i}`, from), block: true }))
  }
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: lineStartOf(doc, cursorLine) },
      extensions: [editorExtensions(), EditorView.decorations.of(builder.finish())],
    }),
    parent: document.body,
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("block render budget", () => {
  it("renders every block when the budget is infinite (default)", async () => {
    const view = viewWithMarkers(6, 0)
    await flush()
    expect(MarkerWidget.rendered.length).toBe(6)
    view.destroy()
  })

  it("defers far-from-cursor blocks and renders them when the cursor nears", async () => {
    setBlockRenderBudget(4)
    MarkerWidget.rendered.length = 0
    const view = viewWithMarkers(6, 0)   // 块在行 0/4/8/12/16/20
    await flush()
    expect(MarkerWidget.rendered.length).toBe(2)          // 行 0 与 4（|4-0|<=4）
    // 光标移到行 10：恰好冲洗行 8 与 12（|16-10|=6 仍在预算外）
    view.dispatch({ selection: { anchor: lineStartOf(view.state.doc.toString(), 10) } })
    await flush()
    expect(MarkerWidget.rendered.length).toBe(4)
    view.destroy()
    setBlockRenderBudget(Infinity)
  })

  it("restores eager rendering after clearing the budget", async () => {
    setBlockRenderBudget(1)
    MarkerWidget.rendered.length = 0
    const view = viewWithMarkers(4, 0)
    await flush()
    expect(MarkerWidget.rendered.length).toBeLessThan(4)
    setBlockRenderBudget(Infinity)
    view.dispatch({ selection: { anchor: 0 } })           // 触发 flush，全量补渲
    await flush()
    expect(MarkerWidget.rendered.length).toBe(4)
    view.destroy()
  })
})
