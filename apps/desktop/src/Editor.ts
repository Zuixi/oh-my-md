import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import { editorExtensions } from "@omd/engine"
import { imagePasteHandler } from "./imagePaste"

export function createEditor(
  parent: HTMLElement,
  doc = "",
  getDocPath: () => string | null = () => null,
): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // Core editing behaviour — chosen carefully to avoid conflicts with
        // Markdown live-preview (no indentOnInput, no closeBrackets, no autocompletion).
        history(),
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Engine: markdown language + live-preview decorations + mode toggle.
        editorExtensions(),
        imagePasteHandler(getDocPath),
        // Base editor theme: fill the host, sensible line height.
        EditorView.theme({
          "&": { height: "100%", fontSize: "15px" },
          ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
          ".cm-content": { padding: "16px 24px", maxWidth: "780px", margin: "0 auto" },
        }),
      ],
    }),
    parent,
  })
}
