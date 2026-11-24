// TopBar harness: the real tab strip with a stateful parent, so a real browser
// can prove the accessibility rewrite — sibling close buttons (no nested
// interactive content), tablist arrow navigation, and geometry that keeps the
// title clear of the close button at every slot width.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { TopBar } from "../src/TopBar"
import { createFileSession, createSession, type EditorSession } from "../src/session"
import { setLocale } from "../src/i18n"
import "../src/styles.css"

declare global {
  interface Window {
    __closedTabs: number[]
    __focusedTabs: number[]
  }
}

setLocale("en")
window.__closedTabs = []
window.__focusedTabs = []

const version = { resolvedPath: "", fingerprint: "" }
const TABS: EditorSession[] = [
  createFileSession(1, "/notes/alpha.md", "", version),
  createFileSession(2, "/notes/a-very-long-document-name-that-must-ellipsize.md", "", version),
  createSession(3),
]

function Harness() {
  const [activeId, setActiveId] = useState(1)
  const [tabs, setTabs] = useState(TABS)
  return (
    <TopBar
      workspace="/notes"
      filePath="/notes/alpha.md"
      tabs={tabs}
      activeId={activeId}
      dirtyIds={[2]}
      conflictIds={[3]}
      onFocusTab={id => {
        window.__focusedTabs.push(id)
        setActiveId(id)
      }}
      onCloseTab={id => {
        window.__closedTabs.push(id)
        setTabs(current => current.filter(tab => tab.id !== id))
      }}
      onNewTab={() => {}}
    />
  )
}

createRoot(document.getElementById("host")!).render(<Harness />)
