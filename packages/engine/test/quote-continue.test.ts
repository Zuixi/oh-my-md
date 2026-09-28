import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 树驱动命令需要完整语法树：经 helpers 进入模块图（完整解析 + 装饰排空）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { blockPrefixOf } from "../src/format/blockPrefix"
import { continueQuoteSpec } from "../src/format/quotes"

function state(doc: string, head: number) {
  return makeState(doc).update({ selection: { anchor: head } }).state
}

function after(doc: string, head = doc.length) {
  const s = state(doc, head)
  const spec = continueQuoteSpec(s)
  return spec ? s.update(spec).state.doc.toString() : null
}

describe("blockPrefixOf", () => {
  it("reads the quote prefix including its trailing space", () => {
    const s = state("> text", 6)
    const prefix = blockPrefixOf(s, s.doc.line(1))
    expect(prefix?.text).toBe("> ")
    expect(prefix?.marks.map(m => m.kind)).toEqual(["quote"])
    expect(prefix?.blank).toBe(false)
  })

  it("tolerates a missing space after the marker", () => {
    const s = state(">text", 5)
    expect(blockPrefixOf(s, s.doc.line(1))?.text).toBe(">")
  })

  it("collects nested quotes, indentation, list and task markers in order", () => {
    const samples: [string, string][] = [
      ["> > nested", "> > "],
      ["  > indented", "  > "],
      ["- > list quote", "- > "],
      ["> - bullet", "> - "],
      ["> 1. quoted ordered", "> 1. "],
      ["> - [x] done", "> - [x] "],
    ]
    for (const [doc, expected] of samples) {
      const s = state(doc, doc.length)
      expect(blockPrefixOf(s, s.doc.line(1))?.text, doc).toBe(expected)
    }
  })

  it("reports a prefix-only line as blank", () => {
    const s = state("> ", 2)
    expect(blockPrefixOf(s, s.doc.line(1))?.blank).toBe(true)
  })

  it("returns null for plain paragraphs", () => {
    for (const doc of ["hello", "hello > world"]) {
      const s = state(doc, doc.length)
      expect(blockPrefixOf(s, s.doc.line(1)), doc).toBeNull()
    }
  })

  it("reports list prefixes without a quote mark so Enter stays with continueList", () => {
    for (const doc of ["- item", "1. item", "  - item"]) {
      const s = state(doc, doc.length)
      const prefix = blockPrefixOf(s, s.doc.line(1))
      expect(prefix?.marks.every(m => m.kind !== "quote"), doc).toBe(true)
      expect(continueQuoteSpec(s), doc).toBeNull()
    }
  })
})

describe("continueQuoteSpec (Enter)", () => {
  it("continues a paragraph inside one quote", () => {
    expect(after("> hello")).toBe("> hello\n> ")
  })

  it("keeps the source style of a space-less quote", () => {
    expect(after(">hello")).toBe(">hello\n>")
  })

  it("continues nested quotes", () => {
    expect(after("> > deep")).toBe("> > deep\n> > ")
  })

  it("keeps leading indentation", () => {
    expect(after("  > indented")).toBe("  > indented\n  > ")
    expect(after("  > > deep")).toBe("  > > deep\n  > > ")
    expect(after("  - > item")).toBe("  - > item\n  - > ")
  })

  it("keeps the quote when the quote lives inside a list item", () => {
    expect(after("- > list quote")).toBe("- > list quote\n- > ")
  })

  it("continues a bullet inside a quote", () => {
    expect(after("> - bullet")).toBe("> - bullet\n> - ")
  })

  it("increments an ordered marker inside a quote", () => {
    expect(after("> 1. first")).toBe("> 1. first\n> 2. ")
  })

  it("resets a checked task to an unchecked one inside a quote", () => {
    expect(after("> - [x] done")).toBe("> - [x] done\n> - [ ] ")
  })

  it("splits the line at the caret", () => {
    expect(after("> hello", 4)).toBe("> he\n> llo")
  })

  it("exits one level on a prefix-only line", () => {
    expect(after("> ")).toBe("")
    expect(after("> > ")).toBe("> ")
    expect(after("> - ")).toBe("> ")
    expect(after("> - hello\n> - ", 14)).toBe("> - hello\n> ")
  })

  it("leaves pure list lines to continueList", () => {
    expect(continueQuoteSpec(state("- hello", 7))).toBeNull()
    expect(continueQuoteSpec(state("1. a", 4))).toBeNull()
  })

  it("leaves plain paragraphs alone", () => {
    expect(continueQuoteSpec(state("hello", 5))).toBeNull()
  })

  it("defers to the default Enter for a non-empty selection", () => {
    const s = EditorState.create({ doc: "> hello", selection: { anchor: 2, head: 5 } })
    expect(continueQuoteSpec(s)).toBeNull()
  })

  it("keeps the quote prefix while a fence is still unclosed", () => {
    expect(after("> ```js")).toBe("> ```js\n> ")
  })
})

function pressEnter(view: EditorView) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  }))
}

function viewWith(doc: string, extensions: Extension[]) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions }),
    parent,
  })
}

describe("quoteKeymap ordering", () => {
  const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

  it("wins over the default Enter because it registers before listKeymap", () => {
    const view = viewWith("> hello", [hostKeys, editorExtensions()])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("> hello\n> ")
    view.destroy()
  })

  it("leaves list continuation to continueList", () => {
    const view = viewWith("- hello", [hostKeys, editorExtensions()])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("- hello\n- ")
    view.destroy()
  })
})
