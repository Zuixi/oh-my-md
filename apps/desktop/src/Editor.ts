import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import { editorExtensions } from "@omd/engine"
import { imagePasteHandler } from "./imagePaste"
import { convertFileSrc } from "@tauri-apps/api/core"

// markdown 图片 src → 可加载 URL：远程/data 原样；相对路径按文档目录 resolve
function makeResolver(getDocPath: () => string | null) {
  return (src: string) => {
    if (/^(https?:|data:|asset:)/.test(src)) return src
    const docPath = getDocPath()
    if (!docPath) return src
    const dir = docPath.slice(0, docPath.replace(/\\/g, "/").lastIndexOf("/") + 1)
    return convertFileSrc(dir + src)
  }
}

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
        editorExtensions({ resolveImageSrc: makeResolver(getDocPath) }),
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
