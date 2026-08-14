import {
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"

// Markdown 排版命令。全部是纯函数：给定 EditorState 返回 TransactionSpec（或 null），
// 由 Command 包装 dispatch，便于 headless 测试。live/source 两模式共用——它们只改源码文本。

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

interface LineChange {
  from: number
  to: number
  insert: string
}

/** Maps a selection through prefix edits. A collapsed cursor follows the inserted marker. */
function mapSelection(
  state: EditorState,
  changes: readonly LineChange[],
  from: number,
  to: number,
): { anchor: number; head: number } {
  const set = state.changes(changes)
  const anchor = set.mapPos(from, 1)
  if (from === to) return { anchor, head: anchor }
  return { anchor, head: set.mapPos(to, -1) }
}

// --- 行内标记（加粗/斜体/删除线/行内代码）---------------------------------------

function toggleInlineSpec(state: EditorState, marker: string): TransactionSpec | null {
  const { from, to } = state.selection.main
  if (to - from >= marker.length * 2) {
    const selected = state.doc.sliceString(from, to)
    if (selected.startsWith(marker) && selected.endsWith(marker)) {
      const inner = selected.slice(marker.length, -marker.length)
      return {
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      }
    }
  }
  const empty = from === to
  let text = ""
  let wrapFrom = from
  let wrapTo = to
  if (empty) {
    const word = state.wordAt(from)
    if (word) {
      wrapFrom = word.from
      wrapTo = word.to
      text = state.doc.sliceString(word.from, word.to)
    }
  } else {
    text = state.doc.sliceString(from, to)
  }
  const insert = marker + text + marker
  return {
    changes: { from: wrapFrom, to: wrapTo, insert },
    selection: empty
      ? { anchor: wrapFrom + marker.length }
      : { anchor: wrapFrom + marker.length, head: wrapFrom + marker.length + text.length },
  }
}

function toggleInlineCodeSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  if (to - from >= 2) {
    const selected = state.doc.sliceString(from, to)
    if (selected.startsWith("`") && selected.endsWith("`")) {
      return toggleInlineSpec(state, "`")
    }
    return toggleInlineSpec(state, selected.includes("`") ? "``" : "`")
  }
  const selected = state.doc.sliceString(from, to)
  return toggleInlineSpec(state, selected.includes("`") ? "``" : "`")
}

export const toggleBold = dispatchSpec(state => toggleInlineSpec(state, "**"))
export const toggleItalic = dispatchSpec(state => toggleInlineSpec(state, "*"))
export const toggleStrikethrough = dispatchSpec(state => toggleInlineSpec(state, "~~"))
export const toggleInlineCode = dispatchSpec(toggleInlineCodeSpec)

// --- 标题 ----------------------------------------------------------------------

const ATX_HEADING = /^(#{1,6})(?:\s+|$)/

function headingPrefix(text: string, level: number): { insert: string; remove: number } {
  const match = text.match(ATX_HEADING)
  if (match) {
    if (match[1].length === level) return { insert: "", remove: match[0].length }
    return { insert: "#".repeat(level) + " ", remove: match[0].length }
  }
  return { insert: "#".repeat(level) + " ", remove: 0 }
}

function toggleHeadingSpec(state: EditorState, level: number): TransactionSpec | null {
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const changes: LineChange[] = []
  for (let n = startLine.number; n <= endLine.number; n += 1) {
    const line = state.doc.line(n)
    const prefix = headingPrefix(line.text, level)
    changes.push({ from: line.from, to: line.from + prefix.remove, insert: prefix.insert })
  }
  return { changes, selection: mapSelection(state, changes, from, to) }
}

export function toggleHeading(level: number): Command {
  return dispatchSpec(state => toggleHeadingSpec(state, level))
}

// --- 列表 / 引用 -----------------------------------------------------------------

const UNORDERED_MARK = /^([-*+])(?:\s+|$)/
const ORDERED_MARK = /^(\d+)([.)])(?:\s+|$)/

function listPrefix(text: string, ordered: boolean): { insert: string; remove: number } {
  if (ordered) {
    if (ORDERED_MARK.test(text)) return { insert: "", remove: text.match(ORDERED_MARK)![0].length }
    if (UNORDERED_MARK.test(text)) return { insert: "1. ", remove: text.match(UNORDERED_MARK)![0].length }
    return { insert: "1. ", remove: 0 }
  }
  if (UNORDERED_MARK.test(text)) return { insert: "", remove: text.match(UNORDERED_MARK)![0].length }
  if (ORDERED_MARK.test(text)) return { insert: "- ", remove: text.match(ORDERED_MARK)![0].length }
  return { insert: "- ", remove: 0 }
}

function orderedNextNumber(state: EditorState, line: number): number {
  if (line <= 1) return 1
  const previous = state.doc.line(line - 1).text.match(ORDERED_MARK)
  return previous ? parseInt(previous[1], 10) + 1 : 1
}

function toggleListSpec(state: EditorState, ordered: boolean): TransactionSpec | null {
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const changes: LineChange[] = []
  let next = orderedNextNumber(state, startLine.number)
  for (let n = startLine.number; n <= endLine.number; n += 1) {
    const line = state.doc.line(n)
    let prefix = listPrefix(line.text, ordered)
    if (ordered && prefix.remove === 0) {
      prefix = { insert: `${next}. `, remove: 0 }
      next += 1
    }
    changes.push({ from: line.from, to: line.from + prefix.remove, insert: prefix.insert })
  }
  return { changes, selection: mapSelection(state, changes, from, to) }
}

export const toggleOrderedList = dispatchSpec(state => toggleListSpec(state, true))
export const toggleUnorderedList = dispatchSpec(state => toggleListSpec(state, false))

function toggleQuoteSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const changes: LineChange[] = []
  for (let n = startLine.number; n <= endLine.number; n += 1) {
    const line = state.doc.line(n)
    const quoted = line.text.startsWith("> ")
    const prefix = quoted ? { insert: "", remove: 2 } : { insert: "> ", remove: 0 }
    changes.push({ from: line.from, to: line.from + prefix.remove, insert: prefix.insert })
  }
  return { changes, selection: mapSelection(state, changes, from, to) }
}

export const toggleBlockquote = dispatchSpec(toggleQuoteSpec)

// --- 代码块 ----------------------------------------------------------------------

const FENCE = /^\s*(```+|~~~+)\s*$/

function paragraphRange(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  let start = line.number
  let end = line.number
  while (start > 1 && state.doc.line(start - 1).text.trim() !== "") start -= 1
  while (end < state.doc.lines && state.doc.line(end + 1).text.trim() !== "") end += 1
  return { from: state.doc.line(start).from, to: state.doc.line(end).to }
}

function toggleCodeBlockSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  if (startLine.number !== endLine.number && FENCE.test(startLine.text) && FENCE.test(endLine.text)) {
    const inner = state.doc.sliceString(startLine.to + 1, endLine.from - 1)
    return {
      changes: { from: startLine.from, to: endLine.to, insert: inner },
      selection: { anchor: startLine.from },
    }
  }
  const empty = from === to
  const wrapFrom = empty ? paragraphRange(state, from).from : startLine.from
  const wrapTo = empty ? paragraphRange(state, to).to : endLine.to
  return {
    changes: [
      { from: wrapFrom, to: wrapFrom, insert: "```\n" },
      { from: wrapTo, to: wrapTo, insert: "\n```" },
    ],
  }
}

export const toggleCodeBlock = dispatchSpec(toggleCodeBlockSpec)

// --- 链接 ------------------------------------------------------------------------

function insertLinkSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  let text = ""
  let textFrom = from
  let textTo = to
  if (to > from) {
    text = state.doc.sliceString(from, to)
  } else {
    const word: SelectionRange | null = state.wordAt(from)
    if (word) {
      textFrom = word.from
      textTo = word.to
      text = state.doc.sliceString(word.from, word.to)
    }
  }
  const href = /^https?:\/\/|^www\./i.test(text) ? text : ""
  const insert = `[${text}](${href})`
  const cursor = textFrom + text.length + 3
  return {
    changes: { from: textFrom, to: textTo, insert },
    selection: { anchor: cursor, head: cursor + href.length },
  }
}

export const insertLink = dispatchSpec(insertLinkSpec)

// --- 键位 -------------------------------------------------------------------------

export const markdownKeymap = keymap.of([
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-`", run: toggleInlineCode },
  { key: "Mod-Shift-~", run: toggleInlineCode },
  { key: "Mod-Shift-k", run: toggleCodeBlock },
  { key: "Mod-1", run: toggleHeading(1) },
  { key: "Mod-2", run: toggleHeading(2) },
  { key: "Mod-3", run: toggleHeading(3) },
  { key: "Mod-4", run: toggleHeading(4) },
  { key: "Mod-5", run: toggleHeading(5) },
  { key: "Mod-6", run: toggleHeading(6) },
  { key: "Mod-Alt-7", run: toggleOrderedList },
  { key: "Mod-Alt-8", run: toggleUnorderedList },
  { key: "Mod-Alt-9", run: toggleBlockquote },
  { key: "Mod-k", run: insertLink },
])
