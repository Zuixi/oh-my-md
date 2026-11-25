import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { MediaInspectTarget } from "@omd/engine"
import { createEditor } from "../src/Editor"
import { MediaLightbox } from "../src/MediaLightbox"
import { setLocale } from "../src/i18n"
import "../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
setLocale("en")

const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#2563eb"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-size="28">Sample Image</text></svg>',
)}`

const DEFAULT_DOC = [
  "# Media Lightbox Demo",
  "",
  `![Sample diagram](${SAMPLE_IMAGE} "Sample caption")`,
  "",
  "```mermaid",
  "graph LR",
  '  A["Editor<br>Multi-line"] --> B["Mermaid Widget<br>HTML Labels"]',
  "  B --> C[Full-screen Lightbox]",
  "  C --> D[Zoom & Pan]",
  "```",
  "",
  "Tail paragraph for resting cursor.",
].join("\n")

function Harness() {
  const editorElRef = useRef<HTMLDivElement | null>(null)
  const [inspected, setInspected] = useState<MediaInspectTarget | null>(null)

  useEffect(() => {
    const parent = editorElRef.current
    if (!parent) return
    const doc = params.get("doc") ?? DEFAULT_DOC
    const view = createEditor(parent, {
      doc,
      tabId: 1,
      documentId: 1,
      getDocPath: () => null,
      getDocumentId: () => 1,
      onDocumentUpdate: () => {},
      onError: () => {},
      onInspectMedia: setInspected,
    })
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    return () => view.destroy()
  }, [])

  return (
    <div className="app">
      <div ref={editorElRef} className="editor-host" style={{ flex: 1, overflow: "hidden" }} />
      <MediaLightbox target={inspected} onClose={() => setInspected(null)} />
    </div>
  )
}

createRoot(document.getElementById("host")!).render(<Harness />)
