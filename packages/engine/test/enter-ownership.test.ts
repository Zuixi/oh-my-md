import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
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

/**
 * 结构断言：某一行最内层 `ListItem` 的嵌套深度（顶层 = 1，非列表行 = 0）。
 * 缩进类 bug 的可见结果可能只是多了几列空格，真正要锁的是重解析后那一项落在哪一层。
 */
function listDepth(state: EditorState, lineNumber: number): number {
  const line = state.doc.line(lineNumber)
  const items: SyntaxNode[] = []
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.name === "ListItem" && node.from >= line.from && node.from <= line.to) items.push(node.node)
    },
  })
  let depth = 0
  for (let node: SyntaxNode | null = items[items.length - 1] ?? null; node; node = node.parent) {
    if (node.name === "ListItem") depth++
  }
  return depth
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

  it("leaves a quoted task item to the list command", () => {
    // TaskMarker 不是 owner：`> - [x] done` 的最内层非任务标记是 ListMark。
    const doc = "> - [x] done"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - [x] done\n> - [ ] ")
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

  it("exits a fenced code block from its final empty content line", () => {
    const doc = "```c\nfdaf\n\n```"
    const view = viewWith(doc, doc.lastIndexOf("\n```"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```c\nfdaf\n\n```\n")
    expect(caret(view)).toMatchObject({ line: 5, offset: 0, text: "" })
    view.destroy()
  })

  it("keeps an empty code line editable when content still follows it", () => {
    const doc = "```c\nfdaf\n\nmore\n```"
    const view = viewWith(doc, doc.indexOf("\n\n") + 1)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```c\nfdaf\n\n\nmore\n```")
    expect(caret(view)).toMatchObject({ line: 4, offset: 0, text: "" })
    view.destroy()
  })

  it("exits a quoted code block into the surrounding quote", () => {
    const doc = "> ```c\n> fdaf\n> \n> ```"
    const view = viewWith(doc, doc.lastIndexOf("\n> ```"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> ```c\n> fdaf\n> \n> ```\n> ")
    expect(caret(view)).toMatchObject({ line: 5, offset: 2, text: "> " })
    view.destroy()
  })

  it("reuses an existing whitespace-only line after the closing fence", () => {
    const doc = "```c\nfdaf\n\n```\n  "
    const view = viewWith(doc, doc.lastIndexOf("\n```"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe(doc)
    expect(caret(view)).toMatchObject({ line: 5, offset: 2, text: "  " })
    view.destroy()
  })

  it("aligns a paired closing brace on an unindented fenced code line", () => {
    // `{|}` 是 auto-pair 的产物，不是用户手打的两个括号：继续行若把闭合花括号推到
    // 新行，用户拿到的是 `{\n  }` —— 这个用例锁的是「`}` 留在与 `{` 同一列的新行」。
    const doc = "```cpp\n{}\n```"
    const view = viewWith(doc, doc.indexOf("}"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```cpp\n{\n  \n}\n```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 2, text: "  " })
    view.destroy()
  })

  it("keeps the existing content indent and adds one level for a paired brace", () => {
    const doc = "```cpp\n  {}\n```"
    const view = viewWith(doc, doc.indexOf("}"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("```cpp\n  {\n    \n  }\n```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 4, text: "    " })
    view.destroy()
  })

  it("repeats the quote prefix on both paired-brace lines", () => {
    const doc = "> ```cpp\n> {}\n> ```"
    const view = viewWith(doc, doc.indexOf("}"))
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> ```cpp\n> {\n>   \n> }\n> ```")
    expect(caret(view)).toMatchObject({ line: 3, offset: 4, text: ">   " })
    view.destroy()
  })

  it("keeps the opening fence line with continueFence (fence completion still wins)", () => {
    const doc = "> ```js"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> ```js\n> \n> ```")
    view.destroy()
  })

  it("leaves plain paragraphs to the host/upstream commands", () => {
    const paragraph = viewWith("hello", 5)
    press(paragraph, "Enter")
    expect(paragraph.state.doc.toString()).toBe("hello\n")
    paragraph.destroy()
  })

  it("exits an empty top-level item instead of leaving an upstream marker line", () => {
    // 上游 insertNewlineContinueMarkup 在这里产出 "- abc\n\n- "（空行 + 列表标记），
    // 引擎语义是空条目退出列表 —— 只有我们的命令能给出这个结果。
    const doc = "- abc\n- "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- abc\n")
    expect(caret(view)).toMatchObject({ line: 2, offset: 0, text: "" })
    view.destroy()
  })

  it("steps out exactly one list level from an empty nested item", () => {
    const doc = "- parent\n  - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- parent\n- ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 2, text: "- " })
    view.destroy()
  })

  it("steps out a same-line nested empty item", () => {
    // `- - ` 是同一行上的两层 ListItem：退层要用父条目自己的 marker，
    // 不是父行前缀的最内层 marker（否则 Enter 原样重生 `- - `）。
    const doc = "- - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- ")
    expect(caret(view)).toMatchObject({ line: 1, offset: 2, text: "- " })
    view.destroy()
  })

  it("steps out a quoted same-line nested empty item", () => {
    const doc = "> - - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - ")
    expect(caret(view)).toMatchObject({ line: 1, offset: 4, text: "> - " })
    view.destroy()
  })

  it("exits the list on the second Enter after a step-out", () => {
    const doc = "- parent\n  - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- parent\n")
    expect(caret(view)).toMatchObject({ line: 2, offset: 0, text: "" })
    view.destroy()
  })

  it("clamps the continued ordered marker at the CommonMark 9-digit limit", () => {
    // 10 位数字不是 marker：越过 999999999 会让新行变成段落。上限处重复 marker。
    const doc = "999999999. item"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("999999999. item\n999999999. ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 11, text: "999999999. " })
    expect(listDepth(view.state, 2)).toBe(1)
    view.destroy()
  })

  it("indents a same-line ancestor level instead of repeating its marker", () => {
    // `- - child` 的新行是内层 list 的兄弟：祖先标记只留缩进（不是 `- - `）。
    const doc = "- - child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- - child\n  - ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 4, text: "  - " })
    view.destroy()
  })

  it("keeps the quote while indenting a same-line ancestor level", () => {
    const doc = "> - - child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - - child\n>   - ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 6, text: ">   - " })
    view.destroy()
  })

  it("increments only the current ordered marker of a same-line nesting", () => {
    const doc = "1. 1. child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("1. 1. child\n   2. ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 6, text: "   2. " })
    view.destroy()
  })

  it("indents every ancestor level by its own marker width", () => {
    const doc = "- + * child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- + * child\n    * ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 6, text: "    * " })
    view.destroy()
  })
})

// 归属由「最内层非任务块标记」决定：`> - ...` 的最内层标记是 ListMark，引用命令必须
// 让位给列表命令；只有最内层标记是 QuoteMark（`> `、`> > `、`- > `、`> - > `）时引用
// 才拥有 Enter。任务框（TaskMarker）附加在它前面的列表上，自己不当 owner。
describe("Enter ownership for quoted lists (innermost non-task mark wins)", () => {
  it("steps a quoted nested empty item out one list level, not one quote level", () => {
    // 回归：quoteKeymap 先注册会抢走整行，Enter 变成 `> `（丢了一层列表语义）。
    const doc = "> - parent\n>   - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - parent\n> - ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 4, text: "> - " })
    view.destroy()
  })

  it("exits the quoted list on the next Enter after the step-out", () => {
    const doc = "> - parent\n>   - "
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - parent\n> ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 2, text: "> " })
    view.destroy()
  })

  it("continues a non-empty quoted item inside the list", () => {
    const doc = "> - item"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - item\n> - ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 4, text: "> - " })
    view.destroy()
  })

  it("continues a quoted nested item at its own level", () => {
    const doc = "> - parent\n>   - child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - parent\n>   - child\n>   - ")
    view.destroy()
  })

  it("keeps quote ownership for a quote nested inside a list item", () => {
    const doc = "- > quote"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("- > quote\n- > ")
    expect(caret(view)).toMatchObject({ line: 2, offset: 4, text: "- > " })
    view.destroy()
  })

  it("keeps quote ownership on the innermost of a mixed prefix", () => {
    const doc = "> - > deep"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("> - > deep\n> - > ")
    view.destroy()
  })
})

describe("CommonMark tab-stop columns through the real keymap chain", () => {
  it("continues a tab-width same-line ancestor at the inner list level", () => {
    // `-\t` 的祖先内容列是 4（制表位），不是两列：两空格会让新条目爬回外层。
    const doc = "-\t- child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("-\t- child\n    - ")
    expect(listDepth(view.state, 1)).toBe(2)
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("increments only the inner ordered marker after a tab-width outer marker", () => {
    const doc = "1.\t1. child"
    const view = viewWith(doc, doc.length)
    press(view, "Enter")
    expect(view.state.doc.toString()).toBe("1.\t1. child\n    2. ")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("nests a Tab rewrite at the tab-width sibling's content column", () => {
    const doc = "-\tparent\n- child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("-\tparent\n    - child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("keeps the quote at line start while nesting to a tab-width column", () => {
    const doc = "> -\tparent\n> - child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("> -\tparent\n>   - child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("outdents a tab-indented item to the parent marker column", () => {
    const doc = "- parent\n  - child\n\t- grandchild"
    const view = viewWith(doc, doc.length)
    press(view, "Tab", true)
    expect(view.state.doc.toString()).toBe("- parent\n  - child\n  - grandchild")
    expect(listDepth(view.state, 3)).toBe(2)
    view.destroy()
  })

  it("outdents across a mixed space+tab gap", () => {
    const doc = "- parent\n  - child\n \t- grandchild"
    const view = viewWith(doc, doc.length)
    press(view, "Tab", true)
    expect(view.state.doc.toString()).toBe("- parent\n  - child\n  - grandchild")
    expect(listDepth(view.state, 3)).toBe(2)
    view.destroy()
  })
})

describe("CommonMark marker padding through the real keymap chain", () => {
  // 5+ 视觉列的 padding 让正文本身变成缩进代码块，内容列只能按一列算：
  // 拿 `ListMark` + 全部空白当嵌套列会插六格，Tab 的结果是个 `CodeBlock`。
  it("nests a Tab under a sibling whose padding exceeds four columns", () => {
    const doc = "-     parent\n- child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("-     parent\n  - child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("nests a quoted Tab under excessive padding using the one-column fallback", () => {
    const doc = "> -     parent\n> - child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("> -     parent\n>   - child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("nests an ordered Tab under excessive padding using the one-column fallback", () => {
    const doc = "1.     parent\n2. child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("1.     parent\n   1. child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
  })

  it("keeps the real content column for four-column padding", () => {
    const doc = "-    parent\n- child"
    const view = viewWith(doc, doc.length)
    press(view, "Tab")
    expect(view.state.doc.toString()).toBe("-    parent\n     - child")
    expect(listDepth(view.state, 2)).toBe(2)
    view.destroy()
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
