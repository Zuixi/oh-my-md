import { describe, expect, it } from "vitest"
import { collectDecorationSpecs, livePreviewField } from "../src/decorations/build"
import { makeState } from "./helpers"

// 空行零装饰（原样保留）：不再为非光标空行发射 line:omd-empty，
// 彻底消除光标移入移出空行时由于半高/全高切换导致的视口抖动。
// "a\n\n\nb"：line1 "a"@0，空行 @2、@3，line4 "b"@4。

const emptyTags = (doc: string, sel: number) => {
  const state = makeState(doc).update({ selection: { anchor: sel } }).state
  return collectDecorationSpecs(state, 0, doc.length)
    .filter(d => d.tag === "line:omd-empty")
    .map(d => d.from)
}

describe("blank lines keep natural height with zero decorations", () => {
  it("emits zero omd-empty decorations regardless of caret position", () => {
    expect(emptyTags("a\n\n\nb", 0)).toEqual([])
    expect(emptyTags("a\n\n\nb", 2)).toEqual([])
    expect(emptyTags("a\n\n\nb", 3)).toEqual([])
  })

  it("emits zero omd-empty decorations under non-empty selection", () => {
    const state = makeState("a\n\n\nb").update({ selection: { anchor: 0, head: 4 } }).state
    const tags = collectDecorationSpecs(state, 0, 4).map(d => d.tag)
    expect(tags.filter(t => t === "line:omd-empty")).toHaveLength(0)
  })

  it("treats whitespace-only lines as plain lines without decorations", () => {
    expect(emptyTags("a\n   \nb", 0)).toEqual([])
    expect(emptyTags("a\n\t\t\nb", 0)).toEqual([])
  })

  it("does not tag blank lines inside or outside block widgets", () => {
    const doc = "```js\n\nconst x = 1\n\n```\n\ntail"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const empties = collectDecorationSpecs(state, 0, doc.length)
      .filter(d => d.tag === "line:omd-empty")
      .map(d => d.from)
    expect(empties).toEqual([])
  })

  it("keeps specs clean of omd-empty during incremental updates", () => {
    const base = makeState("a\n\n\nb", [livePreviewField])
    expect(base.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty")).toHaveLength(0)
    const onBlank = base.update({ selection: { anchor: 2 } }).state
    expect(onBlank.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty")).toHaveLength(0)
    const away = onBlank.update({ selection: { anchor: 4 } }).state
    expect(away.field(livePreviewField).specs.filter(s => s.tag === "line:omd-empty")).toHaveLength(0)
  })
})
