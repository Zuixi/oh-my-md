import type { EditorState, TransactionSpec } from "@codemirror/state"
import type { Command, EditorView } from "@codemirror/view"
import { inlinePlanState } from "../src/format/inlineCommands"
import { makeState } from "./helpers"

export interface TestSelection {
  readonly from: number
  readonly to?: number
}

/** Runs a command against a fresh, fully parsed state and returns the result. */
export function run(command: Command, doc: string, selection: TestSelection): EditorState {
  const { from, to = from } = selection
  const state = makeState(doc, [inlinePlanState]).update({ selection: { anchor: from, head: to } }).state
  const result = attempt(command, state)
  if (!result.handled) throw new Error("command was not handled")
  return result.next
}

export function attempt(
  command: Command,
  state: EditorState,
): { handled: boolean; next: EditorState } {
  let next = state
  const target = {
    state,
    dispatch: (spec: TransactionSpec) => {
      next = state.update(spec).state
    },
  }
  const handled = command(target as unknown as EditorView)
  return { handled, next }
}

export function runOn(command: Command, state: EditorState): EditorState {
  const result = attempt(command, state)
  if (!result.handled) throw new Error("command was not handled")
  return result.next
}

export function cursor(state: EditorState): { from: number; to: number } {
  const main = state.selection.main
  return { from: main.from, to: main.to }
}
