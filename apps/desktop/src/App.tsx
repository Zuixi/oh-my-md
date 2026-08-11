import { useEffect, useRef, useState } from "react"
import { createEditor } from "./Editor"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { EditorView } from "@codemirror/view"
import "./styles.css"

export default function App() {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!host.current) return
    const view = createEditor(host.current)
    viewRef.current = view
    view.dom.addEventListener("input", () => setDirty(true))
    return () => { view.destroy(); viewRef.current = null }
  }, [])

  async function openFile() {
    const p = await open({ filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }] })
    if (!p || typeof p !== "string") return
    try {
      const contents = await invoke<string>("read_file", { path: p })
      const view = viewRef.current!
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contents } })
      setPath(p); setDirty(false)
    } catch (e) {
      alert(`Open failed: ${e}`)
    }
  }

  async function saveFile() {
    if (!viewRef.current) return
    let p = path
    if (!p) {
      p = (await save({ filters: [{ name: "Markdown", extensions: ["md"] }] })) as string | null
      if (!p) return
    }
    try {
      await invoke("write_file", { path: p, contents: viewRef.current.state.doc.toString() })
      setPath(p); setDirty(false)
    } catch (e) {
      alert(`Save failed: ${e}`)
    }
  }

  // Cmd/Ctrl+O and Cmd/Ctrl+S (window-level). CM6's own keymap handles editing keys.
  // Use a stable ref so the effect is registered only once (empty dep array),
  // while the handler always sees the latest `path` and `viewRef` values.
  const openFileRef = useRef(openFile)
  const saveFileRef = useRef(saveFile)
  useEffect(() => { openFileRef.current = openFile })
  useEffect(() => { saveFileRef.current = saveFile })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (e.key === "o") { e.preventDefault(); openFileRef.current() }
      else if (e.key === "s") { e.preventDefault(); saveFileRef.current() }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  return (
    <div className="app">
      <div className="statusbar">{path ?? "untitled"}{dirty ? " •" : ""}</div>
      <div ref={host} className="editor-host" />
    </div>
  )
}
