import { useEffect, useRef, useState } from "react"
import {
  createEditor,
  resetEditorDocument,
  type CreateEditorOptions,
} from "./Editor"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { EditorView } from "@codemirror/view"
import "./styles.css"

export interface DesktopServices {
  pickOpenPath: () => Promise<string | null>
  pickSavePath: () => Promise<string | null>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, contents: string) => Promise<void>
  allowDocumentAssets: (path: string) => Promise<void>
  confirmDiscard: () => boolean
  reportError: (message: string) => void
}

interface AppProps {
  services?: DesktopServices
}

const defaultServices: DesktopServices = {
  pickOpenPath: async () => {
    const path = await open({
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      ],
    })
    return typeof path === "string" ? path : null
  },
  pickSavePath: async () => {
    const path = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
    })
    return typeof path === "string" ? path : null
  },
  readFile: (path) => invoke<string>("read_file", { path }),
  writeFile: async (path, contents) => {
    await invoke("write_file", { path, contents })
  },
  allowDocumentAssets: async (path) => {
    await invoke("allow_document_assets", { documentPath: path })
  },
  confirmDiscard: () =>
    window.confirm("Discard unsaved changes and open another document?"),
  reportError: (message) => window.alert(message),
}

function errorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${detail}`
}

export default function App({ services = defaultServices }: AppProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const pathRef = useRef<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const documentIdRef = useRef(1)
  const openRequestRef = useRef(0)
  const savedContentsRef = useRef("")
  // ponytail: saves share one queue; overlapping opens use a request token
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const openingRef = useRef(false)
  const mountedRef = useRef(false)

  function setSessionDirty(value: boolean) {
    dirtyRef.current = value
    setDirty(value)
  }

  function handleDocChanged(doc: string) {
    setSessionDirty(doc !== savedContentsRef.current)
  }

  function editorOptions(doc: string): CreateEditorOptions {
    return {
      doc,
      getDocPath: () => pathRef.current,
      getDocumentId: () => documentIdRef.current,
      onDocChanged: handleDocChanged,
      onError: (message) => {
        if (mountedRef.current) services.reportError(message)
      },
    }
  }

  function sameSession(documentId: number, view: EditorView) {
    return (
      documentIdRef.current === documentId &&
      viewRef.current === view &&
      mountedRef.current
    )
  }

  useEffect(() => {
    if (!host.current) return
    mountedRef.current = true
    const view = createEditor(host.current, editorOptions(""))
    viewRef.current = view
    return () => {
      mountedRef.current = false
      viewRef.current = null
      documentIdRef.current += 1
      openRequestRef.current += 1
      view.destroy()
    }
  }, [])

  async function openFile() {
    const request = ++openRequestRef.current
    await saveQueueRef.current.catch(() => undefined)
    if (request !== openRequestRef.current || !mountedRef.current) return
    openingRef.current = true
    try {
      if (dirtyRef.current && !services.confirmDiscard()) return
      const nextPath = await services.pickOpenPath()
      if (!nextPath || request !== openRequestRef.current) return
      const contents = await services.readFile(nextPath)
      if (request !== openRequestRef.current || !mountedRef.current) return

      const view = viewRef.current
      if (!view) return
      const previousPath = pathRef.current
      const previousDocumentId = documentIdRef.current
      const previousSavedContents = savedContentsRef.current
      pathRef.current = nextPath
      documentIdRef.current += 1
      savedContentsRef.current = contents
      try {
        await services.allowDocumentAssets(nextPath)
        resetEditorDocument(view, editorOptions(contents))
      } catch (error) {
        pathRef.current = previousPath
        documentIdRef.current = previousDocumentId
        savedContentsRef.current = previousSavedContents
        throw error
      }
      setPath(nextPath)
      setSessionDirty(false)
    } catch (error) {
      if (request === openRequestRef.current && mountedRef.current) {
        services.reportError(errorMessage("Open failed", error))
      }
    } finally {
      if (request === openRequestRef.current) openingRef.current = false
    }
  }

  async function saveFile() {
    if (openingRef.current) return
    const view = viewRef.current
    if (!view) return
    const documentId = documentIdRef.current
    const snapshot = view.state.doc.toString()

    const operation = saveQueueRef.current.catch(() => undefined).then(async () => {
      try {
        if (!sameSession(documentId, view)) return
        const targetPath = pathRef.current ?? (await services.pickSavePath())
        if (!targetPath || !sameSession(documentId, view)) return
        await services.writeFile(targetPath, snapshot)
        if (!sameSession(documentId, view)) return
        await services.allowDocumentAssets(targetPath)
        if (!sameSession(documentId, view)) return
        pathRef.current = targetPath
        setPath(targetPath)
        savedContentsRef.current = snapshot
        setSessionDirty(view.state.doc.toString() !== snapshot)
      } catch (error) {
        if (mountedRef.current) {
          services.reportError(errorMessage("Save failed", error))
        }
      }
    })
    saveQueueRef.current = operation
    await operation
  }

  const openFileRef = useRef(openFile)
  const saveFileRef = useRef(saveFile)
  openFileRef.current = openFile
  saveFileRef.current = saveFile

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (e.key === "o") {
        e.preventDefault()
        void openFileRef.current()
      } else if (e.key === "s") {
        e.preventDefault()
        void saveFileRef.current()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  return (
    <div className="app">
      <div className="statusbar">
        {path ?? "untitled"}
        {dirty ? " •" : ""}
      </div>
      <div ref={host} className="editor-host" />
    </div>
  )
}
