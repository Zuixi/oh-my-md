// E2E harness: mounts the real desktop editor (src/Editor.ts + styles.css) in a
// plain browser page — no React App, no Tauri IPC. The visual-regression class we
// keep shipping (zero-height elements, container seams, collapsed rows) is invisible
// to happy-dom, which has no layout engine; only a real browser layout can see it.
// Playwright loads /e2e/harness.html?doc=<encodeURIComponent(markdown)>&theme=light|dark
import "../src/styles.css"
import { createEditor } from "../src/Editor"

declare global {
  interface Window {
    __view: ReturnType<typeof createEditor>
    __harnessErrors: string[]
  }
}

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"

// `apBrackets` / `apQuotes` / `apMarkdown` let a spec construct the editor with one
// auto-pair toggle off (`?apQuotes=0`). Absent params keep the shipped defaults
// (`DEFAULT_AUTO_PAIR`, all true), so every existing spec is unaffected.
const autoPair = {
  brackets: params.get("apBrackets") !== "0",
  quotes: params.get("apQuotes") !== "0",
  markdownSyntax: params.get("apMarkdown") !== "0",
}

const host = document.createElement("div")
host.className = "editor-host"
document.body.replaceChildren(host)

window.__harnessErrors = []
window.__view = createEditor(host, {
  doc: params.get("doc") ?? "",
  tabId: 1,
  documentId: 1,
  getDocPath: () => null,
  getDocumentId: () => 1,
  autoPair,
  onDocumentUpdate: () => {},
  onError: message => { window.__harnessErrors.push(message) },
})
// Default caret sits at the document end (rendered-block territory), and the
// view owns focus so keyboard-driven specs can type without clicking first.
window.__view.dispatch({ selection: { anchor: window.__view.state.doc.length } })
window.__view.focus()
