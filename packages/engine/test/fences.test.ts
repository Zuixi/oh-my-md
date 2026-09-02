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

  // CommonMark 把未闭合围栏吞到文档末尾：文档中间输入 ```cpp 时下方文字全在
  // 节点内，旧守卫（node.to 不得越过本行）因此永远拦截 —— 修复后按“只有一个
  // CodeMark（无闭合）”精确判定，中间也立即闭合成空块，下方文字留在块后。
  it("completes mid-document with text below, keeping the text after the block", () => {
    const doc = "intro\n\n```cpp\n\noutro text"
    const r = apply(doc, doc.indexOf("```cpp") + 6)
    expect(r.fired).toBe(true)
    expect(r.doc).toBe("intro\n\n```cpp\n\n```\n\noutro text")
    expect(r.caret).toBe(doc.indexOf("```cpp") + 7)
  })

  it("refuses when the caret is on a content line of an unclosed fence", () => {
    const doc = "```cpp\nint x"
    expect(apply(doc, doc.length).fired).toBe(false)
  })
})
