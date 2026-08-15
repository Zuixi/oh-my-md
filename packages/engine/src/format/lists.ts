import { type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"

const LINE = /^(\s*)((?:> )*)([-*+]|\d+[.)])( \[[ xX]\])?(\s|$)/

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

function currentLineMatch(state: EditorState) {
  const line = state.doc.lineAt(state.selection.main.head)
  const match = line.text.match(LINE)
  return match ? { line, match } : null
}

function nextMarker(match: RegExpMatchArray): string {
  const indent = `${match[1] ?? ""}${match[2] ?? ""}`
  const bullet = match[3]
  const ordered = bullet.match(/^(\d+)([.)])$/)
  const marker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : bullet
  const task = match[4] ? " [ ]" : ""
  return `${indent}${marker}${task} `
}

export function continueListSpec(state: EditorState): TransactionSpec | null {
  const found = currentLineMatch(state)
  if (!found) return null
  const { line, match } = found
  if (line.text.slice(match[0].length).trim() === "") {
    return { changes: { from: line.from, to: line.to, insert: "" } }
  }
  const head = state.selection.main.head
  return { changes: { from: head, to: head, insert: `\n${nextMarker(match)}` } }
}

export function indentListSpec(state: EditorState): TransactionSpec | null {
  const found = currentLineMatch(state)
  if (!found) return null
  return { changes: { from: found.line.from, to: found.line.from, insert: "  " } }
}

export function outdentListSpec(state: EditorState): TransactionSpec | null {
  const found = currentLineMatch(state)
  if (!found || !found.line.text.startsWith("  ")) return null
  return { changes: { from: found.line.from, to: found.line.from + 2, insert: "" } }
}

export const continueList = dispatchSpec(continueListSpec)
export const indentList = dispatchSpec(indentListSpec)
export const outdentList = dispatchSpec(outdentListSpec)

export const listKeymap = keymap.of([
  { key: "Enter", run: continueList },
  { key: "Tab", run: indentList },
  { key: "Shift-Tab", run: outdentList },
])
