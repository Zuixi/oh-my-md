import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { markdownLanguageSupport } from "../src/parse/markdown"

// ensureSyntaxTree alone does not finish parsing large documents without an
// EditorView: @codemirror/language's ParseWorker only schedules background work
// via requestIdle/setTimeout when a view is attached, so a detached state's
// tree stops at the synchronous initial parse (~3k chars). Under CPU load even
// that varies, which made tree-dependent tests flaky. When the initial parse
// is incomplete, mount a temporary view and forceParsing to completion — the
// advanced tree lives on view.state, which survives view.destroy().
export function makeState(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({ doc, extensions: [markdownLanguageSupport(), ...extra] })
  if (syntaxTree(state).length >= state.doc.length) return state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  forceParsing(view, state.doc.length, 10000)
  const complete = view.state
  view.destroy()
  parent.remove()
  return complete
}
