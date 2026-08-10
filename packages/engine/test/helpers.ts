import { EditorState, type Extension } from "@codemirror/state"
import { forceParsing } from "@codemirror/language"
import { markdownLanguageSupport } from "../src/parse/markdown"

export function makeState(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({ doc, extensions: [markdownLanguageSupport(), ...extra] })
  forceParsing(markdownLanguageSupport().language!, state)
  return state
}