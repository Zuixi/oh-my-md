import { describe, expect, it } from "vitest"
import type { TransactionSpec } from "@codemirror/state"
import { continueFenceSpec } from "../src/format/fences"
import { makeState } from "./helpers"

function apply(doc: string, anchor: number): { doc: string; caret: number; fired: boolean } {
  const state = makeState(doc).update({ selection: { anchor } }).state
  const spec = continueFenceSpec(state) as TransactionSpec | null
  if (!spec) return { doc, caret: anchor, fired: false }
  const tr = state.update(spec)
  return {
    doc: tr.state.doc.toString(),
    caret: tr.state.selection.main.head,
    fired: true,
  }
}

describe("continueFence (Enter completes an unclosed fence)", () => {
  it("completes a language fence and puts the caret on the content line", () => {
    const r = apply("```cpp", 6)
    expect(r.fired).toBe(true)
    expect(r.doc).toBe("```cpp\n\n```")
    expect(r.caret).toBe(7)
  })

  it("completes a bare fence", () => {
    const r = apply("```", 3)
    expect(r.doc).toBe("```\n\n```")
    expect(r.caret).toBe(4)
  })

  it("closes tilde fences with the tilde marker", () => {
    const r = apply("~~~py", 5)
    expect(r.doc).toBe("~~~py\n\n~~~")
  })

  it("closes longer backtick fences with the same run length", () => {
    const r = apply("````rs", 6)
    expect(r.doc).toBe("````rs\n\n````")
  })

  it("preserves a fence info title", () => {
    const r = apply("```ts My title", 14)
    expect(r.doc).toBe("```ts My title\n\n```")
  })

  it("leaves a complete block alone when Enter is pressed on its opening line", () => {
    const r = apply("```js\nx\n```", 5)
    expect(r.fired).toBe(false)
  })

  it("leaves mid-line Enter alone", () => {
    const r = apply("```cpp", 4)
    expect(r.fired).toBe(false)
  })

  it("leaves non-fence lines alone", () => {
    expect(apply("hello", 5).fired).toBe(false)
  })

  it("refuses inside a blockquote", () => {
    expect(apply("> ```", 5).fired).toBe(false)
  })

  it("refuses when the selection is not empty", () => {
    const state = makeState("```cpp").update({ selection: { anchor: 0, head: 6 } }).state
    expect(continueFenceSpec(state)).toBeNull()
  })
})
