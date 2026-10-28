import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { syntaxTree } from "@codemirror/language"
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state"
import { EditorView, keymap, type Command } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { markdownLanguageSupport } from "../src/parse/markdown"
import {
  continueList,
  continueListSpec,
  deleteEmptyTopLevelListSpec,
  indentList,
  indentListSpec,
  listKeymap,
  outdentList,
  outdentListSpec,
} from "../src/format/lists"

// 纯 spec 测试需要完整语法树（行块前缀与 ListItem 祖辈都从树里取）。
function state(doc: string, head = doc.length) {
  return makeState(doc, [], { anchor: head })
}

/** 多个光标（每个 range 都 empty）：列表命令必须整体放行，不猜改哪一端。 */
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

/**
 * 结构断言：某一行最内层 `ListItem` 的嵌套深度（顶层 = 1，非列表行 = 0）。
 * 只比对源码字符串会把「重新解析后仍是外层兄弟」误判成修好 —— Tab 的 bug 正是
 * 编辑后源码看着多缩进了，树里却仍是同一层。
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

/**
 * 某一行上出现的节点名：5+ 列 padding 的用例光看源码缩进不够 —— 多插的空格会让
 * `- child` 重新解析成 `CodeBlock`，只有在树里断言「不是 CodeBlock」才能锁住。
 */
function nodeNames(state: EditorState, lineNumber: number): string[] {
  const line = state.doc.line(lineNumber)
  const names: string[] = []
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.to > line.from && node.from <= line.to) names.push(node.name)
    },
  })
  return names
}

function applied(doc: string, head = doc.length) {
  const s = state(doc, head)
  const spec = continueListSpec(s)
  expect(spec).toBeTruthy()
  const next = s.update(spec!)
  return { doc: next.state.doc.toString(), head: next.state.selection.main.head, state: next.state }
}

describe("continueListSpec: continuation", () => {
  it("continues an unordered item", () => {
    const s = state("- hello")
    expect(continueListSpec(s)?.changes).toEqual({ from: 7, to: 7, insert: "\n- " })
  })

  it("continues an ordered item with next number", () => {
    expect(applied("1. a\n2. b").doc).toBe("1. a\n2. b\n3. ")
  })

  it("continues a multi-digit ordered item from its parsed marker, not a fixed width", () => {
    expect(applied("10. item").doc).toBe("10. item\n11. ")
    expect(applied("9. item").doc).toBe("9. item\n10. ")
  })

  it("continues a task item with an unchecked box", () => {
    expect(applied("- [x] done").doc).toBe("- [x] done\n- [ ] ")
  })

  it("continues a list inside one quote", () => {
    expect(applied("> - hello").doc).toBe("> - hello\n> - ")
  })

  it("increments an ordered marker inside a quote", () => {
    expect(applied("> 1. first").doc).toBe("> 1. first\n> 2. ")
  })

  it("resets a checked quoted task to an unchecked one", () => {
    expect(applied("> - [x] done").doc).toBe("> - [x] done\n> - [ ] ")
  })

  it("continues a quoted item nested under a quoted list, keeping the quote prefix", () => {
    expect(applied("> - parent\n>   - child").doc).toBe("> - parent\n>   - child\n>   - ")
  })

  it("continues a nested quote list", () => {
    expect(applied("> > - hello").doc).toBe("> > - hello\n> > - ")
  })

  it("keeps the caret on the continuation line", () => {
    const next = applied("- hello")
    expect(next.head).toBe("- hello\n- ".length)
  })

  it("continues a non-empty nested item at its own level", () => {
    expect(applied("- parent\n  - child").doc).toBe("- parent\n  - child\n  - ")
  })
})

describe("continueListSpec: empty items", () => {
  it("exits an empty top-level item", () => {
    expect(applied("- hello\n- ").doc).toBe("- hello\n")
  })

  it("exits an empty top-level item with the caret on the emptied line", () => {
    const next = applied("- hello\n- ")
    expect(next.head).toBe("- hello\n".length)
  })

  it("keeps the quote when exiting an empty quoted item", () => {
    expect(applied("> - ").doc).toBe("> ")
  })

  it("keeps the quote when exiting a following empty quoted item", () => {
    expect(applied("> - hello\n> - ").doc).toBe("> - hello\n> ")
  })

  it("steps out exactly one level from an empty nested item", () => {
    expect(applied("- parent\n  - ").doc).toBe("- parent\n- ")
  })

  it("leaves the caret after the parent-level marker", () => {
    const next = applied("- parent\n  - ")
    expect(next.head).toBe("- parent\n- ".length)
  })

  it("steps out one level only, keeping the grandparent indent", () => {
    expect(applied("- a\n  - b\n    - ").doc).toBe("- a\n  - b\n  - ")
  })

  it("steps out a quoted nested item using the parent list marker", () => {
    expect(applied("> - parent\n>   - ").doc).toBe("> - parent\n> - ")
  })

  it("steps out an ordered nested item with the parent list's next marker", () => {
    expect(applied("1. parent\n   1. ").doc).toBe("1. parent\n2. ")
  })

  it("exits the list on a second Enter after stepping out", () => {
    const first = applied("- parent\n  - ")
    const second = first.state.update(continueListSpec(first.state)!)
    expect(second.state.doc.toString()).toBe("- parent\n")
  })
})

// CommonMark 有序 marker 只允许 1–9 位数字：到 999999999 之后再 +1 就是 10 位，
// 新行会重解析成段落（列表视觉上断掉）。上限处**重复**合法 marker，不回绕到 1 ——
// 回绕看起来像列表重新开始；同一有序列表的渲染编号本来就与源码 marker 无关。
const MAX_MARKER = 999999999

describe("continueListSpec: ordered marker digit limit", () => {
  it("increments up to the 9-digit limit", () => {
    expect(applied(`${MAX_MARKER - 1}. item`).doc).toBe(`${MAX_MARKER - 1}. item\n${MAX_MARKER}. `)
    expect(applied(`${MAX_MARKER - 1}) item`).doc).toBe(`${MAX_MARKER - 1}) item\n${MAX_MARKER}) `)
  })

  it("repeats the marker at the limit instead of wrapping to 1", () => {
    expect(applied(`${MAX_MARKER}. item`).doc).toBe(`${MAX_MARKER}. item\n${MAX_MARKER}. `)
    expect(applied(`${MAX_MARKER}) item`).doc).toBe(`${MAX_MARKER}) item\n${MAX_MARKER}) `)
  })

  it("keeps the continuation line its own ordered list item at the limit", () => {
    const next = applied(`${MAX_MARKER}. item`)
    expect(nodeNames(next.state, 2)).toContain("ListMark")
    // 反证：10 位数字不是 CommonMark marker，新行只是上一条目的段落续行（没有自己的 ListMark）。
    expect(nodeNames(state(`${MAX_MARKER}0. item\n${MAX_MARKER}0. `), 2)).not.toContain("ListMark")
  })

  it("clamps the marker copied into an ordered parent step-out", () => {
    // 空子项退一层时复制的是**父条目**的 marker：父层到上限时也必须落在合法 marker 上。
    // 子层要缩进到 9 位 marker 的内容列（11），否则它根本不是嵌套条目。
    const next = applied(`${MAX_MARKER}. parent\n${' '.repeat(11)}1. `)
    expect(next.doc).toBe(`${MAX_MARKER}. parent\n${MAX_MARKER}. `)
    expect(nodeNames(next.state, 2)).toContain("ListMark")
  })
})

// 同一物理行上的嵌套（`- - `）里，父条目自己的列表标记不是父行前缀的最内层标记：
// 退层必须以父 ListItem 自己的 ListMark 为界，而不是拿整行的最内层标记。
describe("continueListSpec: same-line nesting", () => {
  it("steps out one level when parent and child markers share a line", () => {
    expect(applied("- - ").doc).toBe("- ")
  })

  it("keeps the quote when stepping out a quoted same-line nesting", () => {
    expect(applied("> - - ").doc).toBe("> - ")
  })

  it("steps out one level per Enter from three same-line levels", () => {
    // `- - -` 是 CommonMark 的 thematic break（HorizontalRule，没有列表节点），
    // 所以三级同行嵌套用不同 bullet 字符表达同一结构。
    const first = applied("- + * ")
    expect(first.doc).toBe("- + ")
    const second = first.state.update(continueListSpec(first.state)!)
    expect(second.state.doc.toString()).toBe("- ")
    const third = second.state.update(continueListSpec(second.state)!)
    expect(third.state.doc.toString()).toBe("")
  })
})

// 非空续写：同一物理行上的**祖先** ListItem 在自己的内容列上只是缩进，不是要重生的
// 标记。`- - child` 的新行是内层 list 的兄弟（`  - `），不是一个新的外层条目里再嵌一层。
describe("continueListSpec: non-empty same-line nesting", () => {
  it("indents the ancestor level instead of repeating its marker", () => {
    expect(applied("- - child").doc).toBe("- - child\n  - ")
  })

  it("keeps the quote structural while indenting the ancestor list level", () => {
    expect(applied("> - - child").doc).toBe("> - - child\n>   - ")
  })

  it("increments only the current ordered marker, indenting the outer one by its width", () => {
    expect(applied("1. 1. child").doc).toBe("1. 1. child\n   2. ")
  })

  it("indents every ancestor level by its own marker width", () => {
    expect(applied("- + * child").doc).toBe("- + * child\n    * ")
  })

  it("resets the current task box and indents the ancestor level", () => {
    expect(applied("- - [x] child").doc).toBe("- - [x] child\n  - [ ] ")
  })

  it("indents a same-line ancestor that sits above its own child line", () => {
    expect(applied("- - parent\n  - - child").doc).toBe("- - parent\n  - - child\n    - ")
  })

  it("keeps a list nested in a quote nested in a list at its real column", () => {
    // `- > - child` 的 owner 是最内层 ListMark（引用不是最内层）→ 归本命令。
    expect(applied("- > - child").doc).toBe("- > - child\n  > - ")
  })

  it("keeps ancestor indentation at the parsed marker width, not the task box width", () => {
    // 祖先的任务框不占缩进宽度：父条目是 `- [ ] parent`，子条目续写仍是两空格。
    expect(applied("- [ ] parent\n  - child").doc).toBe("- [ ] parent\n  - child\n  - ")
  })

  it("lands the caret after the canonical continuation prefix", () => {
    expect(applied("- - child").head).toBe("- - child\n  - ".length)
  })

  // 制表位：`\t` 走到下一个 4 列停靠点，所以 `-\t- child` 的祖先内容列是 4，不是
  // `mark.text.length` 的 2。两空格会让新行重新解析成**外层**兄弟。
  it("pads an ancestor marker to its tab-stop content column", () => {
    const next = applied("-\t- child")
    expect(next.doc).toBe("-\t- child\n    - ")
    expect(listDepth(next.state, 1)).toBe(2)
    expect(listDepth(next.state, 2)).toBe(2)
  })

  it("increments only the inner ordered marker after a tab-width outer marker", () => {
    const next = applied("1.\t1. child")
    expect(next.doc).toBe("1.\t1. child\n    2. ")
    expect(listDepth(next.state, 1)).toBe(2)
    expect(listDepth(next.state, 2)).toBe(2)
  })
})

describe("continueListSpec: refusals", () => {
  it("returns null outside lists", () => {
    expect(continueListSpec(state("hello"))).toBeNull()
  })

  it("returns null for a non-empty selection", () => {
    const s = makeState("> - hello", [], { anchor: 2, head: 9 })
    expect(continueListSpec(s)).toBeNull()
  })

  it("returns null when the syntax tree does not cover the line", () => {
    // 无语言扩展 → 树为空：不猜结构，放行后续键位。
    const bare = EditorState.create({ doc: "- hello", selection: { anchor: 7 } })
    expect(continueListSpec(bare)).toBeNull()
  })

  it("returns null and stays unhandled when several cursor ranges are present", () => {
    // 两个光标都落在旧路径**确实会改写**的行上：拒绝只能来自多光标守卫。
    const two = multiCursor("- a\n- b", [3, 7])
    expect(continueListSpec(two)).toBeNull()
    expectUnhandled(continueList, two)
  })
})

describe("deleteEmptyTopLevelListSpec (Backspace)", () => {
  it("removes a fresh ordered marker instead of replacing it with nesting spaces", () => {
    const s = state("1. hello\n2. ")
    const spec = deleteEmptyTopLevelListSpec(s)
    expect(spec).toBeTruthy()
    const next = s.update(spec!)
    expect(next.state.doc.toString()).toBe("1. hello\n")
    expect(next.state.selection.main.head).toBe("1. hello\n".length)
  })

  it("keeps an enclosing quote while exiting its top-level list", () => {
    const s = state("> 1. hello\n> 2. ")
    const next = s.update(deleteEmptyTopLevelListSpec(s)!)
    expect(next.state.doc.toString()).toBe("> 1. hello\n> ")
    expect(next.state.selection.main.head).toBe("> 1. hello\n> ".length)
  })

  it("leaves nested items and explicit marker editing to the upstream command", () => {
    expect(deleteEmptyTopLevelListSpec(state("1. parent\n   1. "))).toBeNull()
    expect(deleteEmptyTopLevelListSpec(state("1. hello\n2. ", "1. hello\n2".length))).toBeNull()
    expect(deleteEmptyTopLevelListSpec(state("1. hello\n2. text"))).toBeNull()
  })
})

// Tab / Shift-Tab 的缩进列全部来自 Lezer 位置：Tab 把当前条目挪到前一可嵌套条目的
// 内容列（同容器 sibling，或紧邻的另一种列表容器末项），Shift-Tab 把当前条目挪到
// **父条目自己**的标记列 —— 没有"两空格"。
// 结构取不到（无上级、无同级、树未覆盖）一律 null，放行后续键位。
function structuralSpec(spec: (state: EditorState) => TransactionSpec | null, doc: string, head = doc.length) {
  const s = state(doc, head)
  const result = spec(s)
  if (!result) return null
  const next = s.update(result).state
  return { doc: next.doc.toString(), state: next }
}

const tab = (doc: string, head?: number) => structuralSpec(indentListSpec, doc, head)
const shiftTab = (doc: string, head?: number) => structuralSpec(outdentListSpec, doc, head)

describe("indentListSpec (Tab)", () => {
  it("indents under the previous unordered sibling", () => {
    expect(tab("- parent\n- child")?.doc).toBe("- parent\n  - child")
  })

  it("uses the real multi-digit ordered marker width, not two spaces", () => {
    expect(tab("10. parent\n11. child")?.doc).toBe("10. parent\n    1. child")
  })

  it("nests the first item of an adjacent bullet list under an ordered item", () => {
    const next = tab("1. parent\n- child")
    expect(next?.doc).toBe("1. parent\n   - child")
    expect(listDepth(next!.state, 2)).toBe(2)
  })

  it("does not cross a blank line to find an item in another list container", () => {
    expect(tab("1. parent\n\n- child")).toBeNull()
  })

  it("resets a new ordered child list to 1 while preserving its delimiter", () => {
    expect(tab("1. parent\n2. child")?.doc).toBe("1. parent\n   1. child")
    expect(tab("1) parent\n2) child")?.doc).toBe("1) parent\n   1) child")
  })

  it("keeps the marker when appending to an existing ordered child list", () => {
    const next = tab("1. parent\n   1. child\n2. sibling")
    expect(next?.doc).toBe("1. parent\n   1. child\n   2. sibling")
    expect(listDepth(next!.state, 3)).toBe(2)
  })

  it("inserts after the quote prefix, keeping the quote at line start", () => {
    expect(tab("> - parent\n> - child")?.doc).toBe("> - parent\n>   - child")
  })

  it("nests by the list marker width after a task sibling and keeps the task box", () => {
    // 上一个同级是 `- [ ] parent`：嵌套宽度是 ListMark 的内容列（2），不含 TaskMarker。
    expect(tab("- [ ] parent\n- [x] child")?.doc).toBe("- [ ] parent\n  - [x] child")
  })

  it("nests under a tab-width sibling at its visual content column", () => {
    const next = tab("-\tparent\n- child")
    expect(next?.doc).toBe("-\tparent\n    - child")
    expect(listDepth(next!.state, 1)).toBe(1)
    expect(listDepth(next!.state, 2)).toBe(2)
  })

  it("inserts after the quote prefix up to a tab-width sibling column", () => {
    const next = tab("> -\tparent\n> - child")
    expect(next?.doc).toBe("> -\tparent\n>   - child")
    expect(listDepth(next!.state, 2)).toBe(2)
  })

  // CommonMark：marker 语法之后只有 1–4 视觉列的空白算内容缩进；0 列或 5+ 列时内容列
  // 退化到 markerEnd + 1，其余空白归内容（`-     parent` 的正文其实是缩进代码块）。
  // `BlockPrefixMark.to` 含标记后**全部**空白，拿它当内容列会插六格把新条目推进 CodeBlock。
  it.each([
    ["- parent", 2],
    ["-  parent", 3],
    ["-   parent", 4],
    ["-    parent", 5],
  ])("keeps the real content column for %s", (parent, column) => {
    const next = tab(`${parent}\n- child`)
    expect(next?.doc).toBe(`${parent}\n${" ".repeat(column)}- child`)
    expect(listDepth(next!.state, 2)).toBe(2)
  })

  it("falls back to one column when the sibling's padding exceeds four columns", () => {
    const next = tab("-     parent\n- child")
    expect(next?.doc).toBe("-     parent\n  - child")
    expect(listDepth(next!.state, 2)).toBe(2)
    expect(nodeNames(next!.state, 2)).not.toContain("CodeBlock")
  })

  it("falls back to one column for quoted siblings with excessive padding", () => {
    const next = tab("> -     parent\n> - child")
    expect(next?.doc).toBe("> -     parent\n>   - child")
    expect(listDepth(next!.state, 2)).toBe(2)
    expect(nodeNames(next!.state, 2)).not.toContain("CodeBlock")
  })

  it("falls back to one column for an ordered sibling with excessive padding", () => {
    const next = tab("1.     parent\n2. child")
    expect(next?.doc).toBe("1.     parent\n   1. child")
    expect(listDepth(next!.state, 2)).toBe(2)
    expect(nodeNames(next!.state, 2)).not.toContain("CodeBlock")
  })

  it("measures excessive padding in visual columns across tab stops", () => {
    // `-\t\t` 的空白是 7 视觉列（1 → 4 → 8），同样超出 1–4，退化成一列 → 内容列 2。
    const next = tab("-\t\tparent\n- child")
    expect(next?.doc).toBe("-\t\tparent\n  - child")
    expect(listDepth(next!.state, 2)).toBe(2)
    expect(nodeNames(next!.state, 2)).not.toContain("CodeBlock")
  })

  it("returns null without a previous sibling", () => {
    expect(tab("- only")).toBeNull()
    expect(tab("- parent\n  - child")).toBeNull()
  })

  it("consumes Tab without dispatch when a list item cannot indent", () => {
    const s = state("- only")
    let dispatched = false
    const target = { state: s, dispatch: () => { dispatched = true } }
    expect(indentList(target as unknown as EditorView)).toBe(true)
    expect(dispatched).toBe(false)
  })
})

describe("outdentListSpec (Shift-Tab)", () => {
  it("removes one unordered nesting level", () => {
    expect(shiftTab("- parent\n  - child")?.doc).toBe("- parent\n- child")
  })

  it("removes the exact four-column gap left by a multi-digit ordered parent", () => {
    expect(shiftTab("10. parent\n    - child")?.doc).toBe("10. parent\n- child")
  })

  it("keeps the enclosing quote and the current task text", () => {
    expect(shiftTab("> - parent\n>   - [x] child")?.doc).toBe("> - parent\n> - [x] child")
  })

  // 同一物理行上的嵌套（`- - x`）：对齐空白不存在，退层删的是父条目自己的
  // `ListMark` 到当前标记之间那一整层（含嵌在该层里的任务框 / 引用段）。
  it("removes the parent layer of a same-line nested item", () => {
    expect(shiftTab("- - child")?.doc).toBe("- child")
  })

  it("keeps the enclosing quote when outdenting a quoted same-line nesting", () => {
    expect(shiftTab("> - - child")?.doc).toBe("> - child")
  })

  it("keeps the current task box when outdenting a same-line nested task item", () => {
    expect(shiftTab("> - - [x] child")?.doc).toBe("> - [x] child")
  })

  it("outdents exactly one same-line level per call", () => {
    const first = shiftTab("- + * child")
    expect(first?.doc).toBe("- * child")
    const second = structuralSpec(outdentListSpec, first!.doc)
    expect(second?.doc).toBe("* child")
    expect(structuralSpec(outdentListSpec, second!.doc)).toBeNull()
  })

  it("outdents exactly one level per call across three levels", () => {
    // c 先回到 b 那一层（b 仍嵌在 a 下），再回到顶层；第三次已是顶层 → null。
    const first = shiftTab("- a\n  - b\n    - c")
    expect(first?.doc).toBe("- a\n  - b\n  - c")
    const second = structuralSpec(outdentListSpec, first!.doc)
    expect(second?.doc).toBe("- a\n  - b\n- c")
    expect(structuralSpec(outdentListSpec, second!.doc)).toBeNull()
  })

  // 跨行缩进的删除量按**视觉列**算：制表符不是一列，不能按源码偏移相减。
  it("outdents a tab-indented item to the parent marker column", () => {
    const next = shiftTab("- parent\n  - child\n\t- grandchild")
    expect(next?.doc).toBe("- parent\n  - child\n  - grandchild")
    expect(listDepth(next!.state, 3)).toBe(2)
  })

  it("rewrites a mixed space+tab gap to the parent marker column", () => {
    const next = shiftTab("- parent\n  - child\n \t- grandchild")
    expect(next?.doc).toBe("- parent\n  - child\n  - grandchild")
    expect(listDepth(next!.state, 3)).toBe(2)
  })

  it("returns null at the top level", () => {
    expect(shiftTab("- only")).toBeNull()
  })
})

describe("Tab / Shift-Tab refusals", () => {
  it("returns null for a non-empty selection", () => {
    const multiChar = makeState("- parent\n- child", [], { anchor: 2, head: 16 })
    expect(indentListSpec(multiChar)).toBeNull()
    const nested = makeState("- parent\n  - child", [], { anchor: 2, head: 18 })
    expect(outdentListSpec(nested)).toBeNull()
  })

  it("returns null when the syntax tree does not cover the line", () => {
    const bare = EditorState.create({ doc: "- parent\n- child", selection: { anchor: 16 } })
    expect(indentListSpec(bare)).toBeNull()
    expect(outdentListSpec(bare)).toBeNull()
  })

  it("returns null and stays unhandled when several cursor ranges are present", () => {
    // 两个光标各自都有上一个同级条目（旧路径会缩进 main 那一行）。
    const two = multiCursor("- parent\n- child\n- child2", [16, 25])
    expect(indentListSpec(two)).toBeNull()
    expectUnhandled(indentList, two)
  })

  it("returns null and stays unhandled for Shift-Tab with several cursor ranges", () => {
    // 两个光标各自都嵌在父条目下（旧路径会外移 main 那一行）。
    const two = multiCursor("- parent\n  - child\n  - child2", [17, 26])
    expect(outdentListSpec(two)).toBeNull()
    expectUnhandled(outdentList, two)
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
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions,
    }),
    parent,
  })
}

describe("listKeymap vs defaultKeymap", () => {
  const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

  it("continues a list on Enter when defaultKeymap is registered first", () => {
    const view = viewWith("- hello", [hostKeys, editorExtensions()])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("- hello\n- ")
    view.destroy()
  })

  it("beats defaultKeymap as the only list keymap once the markdown language is mounted", () => {
    // 行结构来自语法树：没有 markdownLanguageSupport 时列表命令按设计返回 null。
    const view = viewWith("- hello", [hostKeys, markdownLanguageSupport(), listKeymap])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("- hello\n- ")
    view.destroy()
  })
})
