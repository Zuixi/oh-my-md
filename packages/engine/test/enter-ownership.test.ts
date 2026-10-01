import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { codeContentLine, continueCodeLineSpec, indentCodeLineSpec, outdentCodeLineSpec } from "../src/format/codeLines"

// 归属测试：断言「只有引擎命令能产出的结果」，而不是两条实现都一致的可见结果。
//
// 教训：@codemirror/lang-markdown 的 markdown() 内部会 push 一个 Prec.high 的 Enter
// 键位（insertNewlineContinueMarkup），而 markdownLanguageSupport() 排在 editorExtensions
// 第一位 —— 同优先级先注册者胜，于是引擎的 Enter 家族被静默架空，而 `> hello` → `> hello\n> `
// 这种「两边一致」的断言完全看不出来。这里每一条都挑了上游做不到或做不对的输入。

const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

function viewWith(doc: string, head: number, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [hostKeys, editorExtensions(), ...extra],
    }),
    parent,
  })
  // 树驱动命令需要完整树：挂临时视图后强制解析（与 codeHighlight.test.ts 同款）。
  forceParsing(view, view.state.doc.length, 10_000)
  return view
}

function press(view: EditorView, key: string, shift = false) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key, shiftKey: shift, bubbles: true, cancelable: true,
  }))
}

function caret(view: EditorView) {
  const { head } = view.state.selection.main
  const line = view.state.doc.lineAt(head)
  return { line: line.number, offset: head - line.from, text: line.text }
}

describe("Enter ownership through the real keymap chain", () => {
  it("exits one quote level on a prefix-only line instead of leaving a bare marker", () => {
    // 上游 insertNewlineContinueMarkup 在这里留下 ">\n> "（孤零零一个 >），
    // 引擎语义是退出一层 —— 只有我们的命令能给出这个结果。
    const doc = "> 引用第一行\n> "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> 引用第一行\n")
    expect(caret(view)).toMatchObject({ line: 2, offset: 0 })
    view.destroy()
  })

  it("exits only the innermost level of a nested quote", () => {
    const doc = "> > 嵌套\n> > "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> > 嵌套\n> ")
    view.destroy()
  })

  it("continues a quoted paragraph and lands the caret after the prefix", () => {
    const doc = "> abc"
    const view = viewWith(doc, 3)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> a\n> bc")
    expect(caret(view)).toMatchObject({ line: 2, offset: 2 })
    view.destroy()
  })

  it("continues a quoted code line with the code indent and moves the caret onto it", () => {
    // 这一条同时锁两件事：① 内容行归 continueCodeLine（不是上游、也不是 continueQuote
    // 的纯前缀续写）；② 光标必须显式落到新行内容起点（插入点正好在光标处时 CodeMirror
    // 的默认映射会把光标留在上一行）。
    const doc = "> ```js\n>   return 0\n> ```"
    const view = viewWith(doc, doc.indexOf("0") + 1)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> ```js\n>   return 0\n>   \n> ```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 4, text: ">   " })
    view.destroy()
  })

  it("continues an unquoted code line with its indentation", () => {
    const doc = "```js\n  return 0\n```"
    const view = viewWith(doc, doc.indexOf("0") + 1)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```js\n  return 0\n  \n```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 2 })
    view.destroy()
  })

  it("indents one more level after an opening bracket", () => {
    const doc = "```js\nfunction f() {\n```"
    const view = viewWith(doc, doc.indexOf("\n", doc.indexOf("{")))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```js\nfunction f() {\n  \n```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 2 })
    view.destroy()
  })

  it("keeps the opening fence line with continueFence (fence completion still wins)", () => {
    const doc = "> ```js"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> ```js\n> \n> ```")
    view.destroy()
  })

  it("leaves plain paragraphs and pure list lines to the host/upstream commands", () => {
    const paragraph = viewWith("hello", 5)
    press(paragraph, "Enter")
    expect(paragraph.state.doc.toString()).toBe("hello\n")
    paragraph.destroy()

    const doc = "- abc"
    const list = viewWith(doc, doc.length)
    press(list, "Enter")
    // 列表续写本版仍归上游（insertNewlineContinueMarkup），结果与引擎命令一致。
    expect(list.state.doc.toString()).toBe("- abc\n- ")
    expect(caret(list)).toMatchObject({ line: 2, offset: 2 })
    list.destroy()
  })
})

describe("code content line detection and indentation commands", () => {
  const state = (doc: string, head: number) => makeState(doc).update({ selection: { anchor: head } }).state

  it("only claims content lines inside a fence", () => {
    const fenced = "```js\nconst a = 1\n```"
    const inside = state(fenced, fenced.indexOf("= 1"))
    expect(codeContentLine(inside)?.content).toBe("const a = 1")
    // 开/闭围栏行、普通段落、列表行一律让位
    expect(codeContentLine(state(fenced, 3))).toBeNull()
    expect(codeContentLine(state(fenced, fenced.length - 1))).toBeNull()
    expect(codeContentLine(state("hello", 3))).toBeNull()
    expect(codeContentLine(state("- abc", 4))).toBeNull()
  })

  it("returns null for a non-empty selection", () => {
    const doc = "```js\nconst a = 1\n```"
    const s = makeState(doc).update({ selection: { anchor: doc.indexOf("const"), head: doc.indexOf("= 1") } }).state
    expect(codeContentLine(s)).toBeNull()
    expect(continueCodeLineSpec(s)).toBeNull()
  })

  it("splits at the content start when the caret sits inside the prefix", () => {
    const doc = "> ```js\n> const a = 1\n> ```"
    const lineFrom = doc.indexOf("> const")
    const spec = continueCodeLineSpec(state(doc, lineFrom + 1))
    expect(spec).toMatchObject({ changes: { from: lineFrom + 2, to: lineFrom + 2, insert: "\n> " } })
  })

  it("indents and outdents the content, never the prefix", () => {
    // `>   return 0`：前缀占 `> `（两个字符），余下两个空格是**代码缩进**，
    // 所以 Tab/Shift-Tab 改的是它们，标记后的第一个空格始终保留。
    const doc = "> ```js\n>   return 0\n> ```"
    const head = doc.indexOf("return")
    const indent = indentCodeLineSpec(state(doc, head))
    expect(indent && state(doc, head).update(indent).state.doc.toString())
      .toBe("> ```js\n>     return 0\n> ```")
    const outdent = outdentCodeLineSpec(state(doc, head))
    expect(outdent && state(doc, head).update(outdent).state.doc.toString())
      .toBe("> ```js\n> return 0\n> ```")

    // 无缩进可退 → null（放行 Shift-Tab 给列表反缩进等后续键位）
    expect(outdentCodeLineSpec(state("```js\nconst a = 1\n```", 10))).toBeNull()
  })
})
