import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { editorExtensions } from "@omd/engine"
// basicSetup provides history (undo/redo), default keymap, line numbers, etc.
import { basicSetup } from "codemirror"

export function createEditor(parent: HTMLElement, doc = ""): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [basicSetup, editorExtensions()],
    }),
    parent,
  })
}
