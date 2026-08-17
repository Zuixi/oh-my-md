import { EditorState, type Extension } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { markdownLanguageSupport } from "../src/parse/markdown"

export function makeState(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({ doc, extensions: [markdownLanguageSupport(), ...extra] })
  ensureSyntaxTree(state, state.doc.length, 5000)  // force full synchronous parse for tests
  return state
}
