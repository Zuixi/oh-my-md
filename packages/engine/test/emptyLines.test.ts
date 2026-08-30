import { describe, expect, it } from "vitest"
import { collectDecorationSpecs, livePreviewField } from "../src/decorations/build"
import { makeState } from "./helpers"

// 空行密度（Typora 观感）：非 caret 空白行折叠为半高（line:omd-empty），
// caret 所在空行保持全高，非空选区不展开（拖选视觉稳定）。
// "a\n\n\nb"：line1 "a"@0，空行 @2、@3，line4 "b"@4。

const emptyTags = (doc: string, sel: number) => {
  const state = makeState(doc).update({ selection: { anchor: sel } }).state
  return collectDecorationSpecs(state, 0, doc.length)
    .filter(d => d.tag === "line:omd-empty")
    .map(d => d.from)
}

describe("blank-line density", () => {
  it("folds every non-caret blank line, stacking consecutive ones", () => {
    expect(emptyTags("a\n\n\nb", 0)).toEqual([2, 3])
  })

  it("keeps the caret's own blank line at full height", () => {
    expect(emptyTags("a\n\n\nb", 2)).toEqual([3])
    expect(emptyTags("a\n\n\nb", 3)).toEqual([2])
  })

  it("folds blank lines under a non-empty selection (selection is visual)", () => {
    const state = makeState("a\n\n\nb").update({ selection: { anchor: 0, head: 4 } }).state
    const tags = collectDecorationSpecs(state, 0, 4).map(d => d.tag)
    expect(tags.filter(t => t === "line:omd-empty")).toHaveLength(2)
  })

  it("treats whitespace-only lines as blank", () => {
    expect(emptyTags("a\n   \nb", 0)).toEqual([2])
    expect(emptyTags("a\n\t\t\nb", 0)).toEqual([2])
  })

  it("does not tag blank lines swallowed by a block widget's source range", () => {
    const doc = "```js\n\nconst x = 1\n\n```\n\ntail"
    // caret after the block: the fence renders as a widget replacing its whole
    // source range — the two inner blank lines are widget-covered and must not
    // get line decorations; only the blank line before "tail" folds.
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const empties = collectDecorationSpecs(state, 0, doc.length)
      .filter(d => d.tag === "line:omd-empty")
      .map(d => d.from)
    expect(empties).toEqual([doc.indexOf("tail") - 1])
  })

  it("re-folds a blank line incrementally when the caret leaves it", () => {
    const base = makeState("a\n\n\nb", [livePreviewField])
    // caret on "b": both blank lines folded
    expect(base.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty").map(s => s.from))
      .toEqual([2, 3])
    // caret moves onto blank line @2: it expands, @3 stays folded
    const onBlank = base.update({ selection: { anchor: 2 } }).state
    expect(onBlank.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty").map(s => s.from))
      .toEqual([3])
    // caret leaves again: the line re-folds
    const away = onBlank.update({ selection: { anchor: 4 } }).state
    expect(away.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty").map(s => s.from))
      .toEqual([2, 3])
  })
})
