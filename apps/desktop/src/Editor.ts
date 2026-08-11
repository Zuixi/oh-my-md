import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import { editorExtensions } from "@omd/engine"

export function createEditor(parent: HTMLElement, doc = ""): EditorView {
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
