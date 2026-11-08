import type { ChangeSpec, EditorState, TransactionSpec } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import {
  containingNode,
  directChildren,
  hasAncestor,
  intersectingNode,
  mapSelection,
  treeCovers,
} from "./semantics"

const CONTAINER_NODES = new Set(["Blockquote", "ListItem"])
const UNSAFE_HOSTS = new Set([
  "FencedCode",
  "CodeBlock",
  "MathBlock",
  "FrontMatter",
  "Table",
  "Blockquote",
  "ListItem",
])

function paragraphRange(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  let start = line.number
  let end = line.number
  while (start > 1 && state.doc.line(start - 1).text.trim() !== "") start -= 1
  while (end < state.doc.lines && state.doc.line(end + 1).text.trim() !== "") end += 1
  return { from: state.doc.line(start).from, to: state.doc.line(end).to }
}

function lineWithBreak(state: EditorState, lineNumber: number): { from: number; to: number } {
  const line = state.doc.line(lineNumber)
  return {
    from: line.from,
    to: line.number < state.doc.lines ? state.doc.line(line.number + 1).from : line.to,
  }
}

function lineWithPreviousBreak(state: EditorState, lineNumber: number): { from: number; to: number } {
  const line = state.doc.line(lineNumber)
  if (line.number <= 1) return { from: line.from, to: line.to }
  return { from: state.doc.line(line.number - 1).to, to: line.to }
}

function unwrapFence(state: EditorState, fence: SyntaxNode): TransactionSpec | null {
  if (hasAncestor(fence, CONTAINER_NODES)) return null
  const marks = directChildren(fence, "CodeMark")
  if (marks.length === 0 || marks.length > 2) return null
  const openingLine = state.doc.lineAt(marks[0].from)
  const changes: ChangeSpec[] = []
  if (marks.length === 1) {
    const opening = lineWithBreak(state, openingLine.number)
    changes.push({ ...opening, insert: "" })
  } else {
    const closingLine = state.doc.lineAt(marks[1].from)
    if (closingLine.number <= openingLine.number + 1) {
      changes.push({
        from: openingLine.from,
        to: closingLine.to,
        insert: "",
      })
    } else {
      changes.push({ ...lineWithBreak(state, openingLine.number), insert: "" })
      changes.push({ ...lineWithPreviousBreak(state, closingLine.number), insert: "" })
    }
  }
  const { from, to } = state.selection.main
  return {
    changes,
    selection: mapSelection(state, changes, from, to),
  }
}

function unsafeHostAt(state: EditorState, from: number, to: number): boolean {
  if (from === to) return containingNode(state, from, to, name => UNSAFE_HOSTS.has(name)) !== null
  return intersectingNode(state, from, to, name => UNSAFE_HOSTS.has(name)) !== null
}

function fenceDelimiter(content: string): string {
  let longestRun = 0
  for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
  return "`".repeat(Math.max(3, longestRun + 1))
}

export function toggleCodeBlockSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  if (!treeCovers(state, from, to)) return null
  const fence = containingNode(state, from, to, name => name === "FencedCode")
  if (fence) return unwrapFence(state, fence)

  const selectedRange = from === to
    ? paragraphRange(state, from)
    : { from: state.doc.lineAt(from).from, to: state.doc.lineAt(to).to }
  if (!treeCovers(state, selectedRange.from, selectedRange.to)) return null
  if (unsafeHostAt(state, selectedRange.from, selectedRange.to)) return null

  const content = state.sliceDoc(selectedRange.from, selectedRange.to)
  const delimiter = fenceDelimiter(content)
  const opening = `${delimiter}\n`
  const closing = `\n${delimiter}`
  const changes: ChangeSpec[] = [
    { from: selectedRange.from, insert: opening },
    { from: selectedRange.to, insert: closing },
  ]
  // Keep a collapsed caret inside the new fence even when it started at the
  // paragraph end. Right-biased mapping would put it after the closing fence,
  // making the next toggle wrap the whole block again instead of unwrapping.
  const selection = from === to
    ? { anchor: selectedRange.from + opening.length + (from - selectedRange.from) }
    : {
        anchor: selectedRange.from + opening.length,
        head: selectedRange.to + opening.length,
      }
  return { changes, selection }
}
