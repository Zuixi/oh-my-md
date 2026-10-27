import { useState } from "react"
import { createRoot } from "react-dom/client"
import { FileTree } from "../src/FileTree"
import { MARKDOWN_FILE_EXTENSION } from "../src/constants"
import { setLocale } from "../src/i18n"
import type { VisibleRow } from "../src/fileTreeState"
import "../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
setLocale("en")

function Harness() {
  const [rows, setRows] = useState<VisibleRow[]>(Array.from({ length: 100 }, (_, i) => {
    const name = i === 0 ? "中文 草稿.md" : `long-file-name-${i}-for-sidebar-layout.md`
    return { entry: { name, path: `/notes/${name}`, is_dir: false }, depth: 0, expanded: false }
  }))
  return <div style={{ display: "flex", height: 480, width: 600 }}>
    <div style={{ display: "flex", width: 280, height: "100%" }}>
      <FileTree
        folder="/notes"
        rows={rows}
        activePath={null}
        onSearch={() => {}}
        onOpenFile={() => {}}
        onToggleDir={() => {}}
        onRename={async (entry, rawName) => {
          await Promise.resolve()
          if (rawName === "taken.md") throw new Error("Name already exists.")
          const name = rawName.endsWith(`.${MARKDOWN_FILE_EXTENSION}`)
            ? rawName : `${rawName}.${MARKDOWN_FILE_EXTENSION}`
          const path = `/notes/${name}`
          setRows(current => current.map(row => row.entry.path === entry.path
            ? { ...row, entry: { ...row.entry, name, path } } : row))
          return path
        }}
      />
    </div>
    <button type="button" style={{ alignSelf: "start", margin: 16 }}>Outside the tree</button>
  </div>
}

createRoot(document.getElementById("host")!).render(<Harness />)
