import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import { editorExtensions } from "@omd/engine"
import { imagePasteHandler } from "./imagePaste"
import { typewriterExtension } from "./typewriter"
import { convertFileSrc } from "@tauri-apps/api/core"

export interface CreateEditorOptions {
  doc: string
  getDocPath: () => string | null
  getDocumentId: () => number
  onDocChanged: (doc: string) => void
  onError: (message: string) => void
}

export function makeImageResolver(
  getDocPath: () => string | null,
  convert: (path: string) => string = convertFileSrc,
) {
  return (src: string) => {
    if (/^(https?:|data:|asset:)/i.test(src)) return src
    const docPath = getDocPath()
    if (!docPath) return src
    const normalizedPath = docPath.replace(/\\/g, "/")
    const dir = normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
    return convert(dir + src)
  }
}

function createEditorState(options: CreateEditorOptions): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      editorExtensions({
        resolveImageSrc: makeImageResolver(options.getDocPath),
      }),
      typewriterExtension(),
      imagePasteHandler({
        getDocPath: options.getDocPath,
        getDocumentId: options.getDocumentId,
        onError: options.onError,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          options.onDocChanged(update.state.doc.toString())
        }
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "15px" },
        ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
        ".cm-content": {
          padding: "16px 24px",
          maxWidth: "780px",
          margin: "0 auto",
        },
      }),
    ],
  })
}

export function createEditor(
  parent: HTMLElement,
  options: CreateEditorOptions,
): EditorView {
  return new EditorView({
    state: createEditorState(options),
    parent,
  })
}

export function resetEditorDocument(
  view: EditorView,
  options: CreateEditorOptions,
): void {
  view.setState(createEditorState(options))
}
