import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"

const LINE = /^(\s*)((?:> )*)([-*+]|\d+[.)])( \[[ xX]\])?(\s|$)/

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    // readOnly 是建议性 facet：keymap 命令直接 dispatch 会绕过输入拦截
    // （typed input 才被 view 层挡下），只读 Live 预览档必须在此拒绝改写。
    // 返回 false 与 @codemirror/commands 的 readOnly 约定一致，放行后续键位。
    if (target.state.readOnly) return false
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
    const insert = match[2] ?? ""
    return { changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } }
  }
  const head = state.selection.main.head
  const insert = `\n${nextMarker(match)}`
  // 显式 selection：否则插入点正好在光标处时，CodeMirror 的默认映射会把光标留在上一行。
  return { changes: { from: head, to: head, insert }, selection: { anchor: head + insert.length } }
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

export const listKeymap = Prec.high(keymap.of([
  { key: "Enter", run: continueList },
  { key: "Tab", run: indentList },
  { key: "Shift-Tab", run: outdentList },
]))
