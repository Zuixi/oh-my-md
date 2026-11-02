import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { EditorSelection, EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap, type Command } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 树驱动命令需要完整语法树：经 helpers 进入模块图（完整解析 + 装饰排空）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { blockPrefixOf } from "../src/format/blockPrefix"
import { continueQuote, continueQuoteSpec } from "../src/format/quotes"

function state(doc: string, head: number) {
  return makeState(doc).update({ selection: { anchor: head } }).state
}

/** 多个光标（每个 range 都 empty）：引用命令必须整体放行，不猜改哪一端。 */
function multiCursor(doc: string, positions: number[]) {
  // 没有 allowMultipleSelections 时 EditorState.update 会把选区压成单个 range。
  return makeState(doc, [EditorState.allowMultipleSelections.of(true)])
    .update({ selection: EditorSelection.create(positions.map(pos => EditorSelection.cursor(pos))) })
    .state
}

/** 命令包装层：返回 false 且从不 dispatch 才算真正放行。 */
function expectUnhandled(command: Command, s: EditorState) {
  let dispatched = false
  const target = { state: s, dispatch: () => { dispatched = true } }
  expect(command(target as unknown as EditorView)).toBe(false)
  expect(dispatched).toBe(false)
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

  it("yields when the innermost non-task mark is a list, even inside a quote", () => {
    // 归属看最内层非任务标记：`> - x` 的最内层是 ListMark → continueList 拥有 Enter；
    // `- > x` / `> - > x` 的最内层是 QuoteMark → 仍由本命令续写。
    for (const doc of ["> - item", "> 1. item", ">   - child", "> - [x] done", "> > - item", "> - "]) {
      const s = state(doc, doc.length)
      expect(continueQuoteSpec(s), doc).toBeNull()
    }
    for (const doc of ["- > item", "> - > item", "> > item"]) {
      const s = state(doc, doc.length)
      expect(continueQuoteSpec(s), doc).not.toBeNull()
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

  it("splits the line at the caret", () => {
    expect(after("> hello", 4)).toBe("> he\n> llo")
  })

  it("splits at the content start when the caret sits inside the prefix", () => {
    // `> |hello`（Home、或在标记与内容之间点击）：标记后的空格属于前缀，不能留在
    // 新行内容前 —— 否则续写结果多一个空格（">  hello"）。
    expect(after("> hello", 1)).toBe("> \n> hello")
    expect(after("> hello", 2)).toBe("> \n> hello")
    expect(after("> > deep", 3)).toBe("> > \n> > deep")
  })

  it("exits one level on a prefix-only line", () => {
    expect(after("> ")).toBe("")
    expect(after("> > ")).toBe("> ")
    expect(after("> - > ")).toBe("> - ")
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

  it("returns null and stays unhandled when several cursor ranges are present", () => {
    // 两个光标都落在旧路径**确实会改写**的行上：拒绝只能来自多光标守卫。
    const two = multiCursor("> a\n> b", [3, 7])
    expect(continueQuoteSpec(two)).toBeNull()
    expectUnhandled(continueQuote, two)
  })

  it("defers an unclosed fence line to continueFence", () => {
    // 围栏行归 continueFence（它按引用前缀补全闭合行并把光标放到内容行）；
    // 两个命令因此互斥，键位注册顺序不影响结果。
    expect(continueQuoteSpec(state("> ```js", 7))).toBeNull()
    expect(continueQuoteSpec(state("  ```js", 7))).toBeNull()
    // 已闭合块内的引用行仍归本命令
    expect(after("> ```js\n> x\n> ```\n> tail")).toBe("> ```js\n> x\n> ```\n> tail\n> ")
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

function viewWithCursors(doc: string, positions: number[], extensions: Extension[]) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(positions.map(pos => EditorSelection.cursor(pos))),
      extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
    }),
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

  it("stays out of a multi-cursor Enter so every range keeps its own continuation", () => {
    // 仅改主光标的分支只会续写第一行；两行都续写说明每个 range 都由后续命令处理。
    const view = viewWithCursors("> a\n> b", [3, 7], [hostKeys, editorExtensions()])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("> a\n> \n> b\n> ")
    view.destroy()
  })
})
