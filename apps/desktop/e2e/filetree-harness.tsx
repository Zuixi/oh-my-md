import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { FileTree } from "../src/FileTree"
import { MARKDOWN_FILE_EXTENSION } from "../src/constants"
import { setLocale } from "../src/i18n"
import type { CreateKind, VisibleRow } from "../src/fileTreeState"
import "../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
setLocale("en")

const DRAFTS = "/notes/drafts"
const DRAFT_CHILDREN = ["draft-a.md", "draft-b.md"]

function fileRow(name: string, folder: string, depth: number): VisibleRow {
  return { entry: { name, path: `${folder}/${name}`, is_dir: false }, depth, expanded: false }
}

function initialRows(expanded: boolean): VisibleRow[] {
  return [
    { entry: { name: "drafts", path: DRAFTS, is_dir: true }, depth: 0, expanded },
    ...draftChildren(expanded),
    ...Array.from({ length: 100 }, (_, i) => fileRow(
      i === 0 ? "中文 草稿.md" : `long-file-name-${i}-for-sidebar-layout.md`,
      "/notes",
      0,
    )),
  ]
}

function draftChildren(expanded: boolean): VisibleRow[] {
  return expanded
    ? DRAFT_CHILDREN.map(name => fileRow(name, DRAFTS, 1))
    : []
}

/** Insert after the directory's last visible descendant, mirroring the app. */
function insertChild(rows: VisibleRow[], dir: string, row: VisibleRow): VisibleRow[] {
  if (dir === "/notes") return [...rows, row]
  const index = rows.findIndex(item => item.entry.is_dir && item.entry.path === dir)
  if (index < 0) return rows
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end += 1
  return [...rows.slice(0, end), row, ...rows.slice(end)]
}

function Harness() {
  const pendingRenameRef = useRef<(() => void) | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [rows, setRows] = useState<VisibleRow[]>(() => initialRows(false))

  const toggleDrafts = () => {
    setRows(current => {
      const index = current.findIndex(row => row.entry.path === DRAFTS)
      if (index < 0) return current
      const expanded = !current[index]!.expanded
      const rest = current.filter(row => !row.entry.path.startsWith(`${DRAFTS}/`))
      return [
        ...rest.slice(0, index),
        { ...rest[index]!, expanded },
        ...draftChildren(expanded),
        ...rest.slice(index + 1),
      ]
    })
  }

  const createEntry = (kind: CreateKind) => async (dir: string, name: string) => {
    await Promise.resolve()
    const isDirectory = kind === "create-folder"
    const path = `${dir}/${name}`
    setRows(current => insertChild(current, dir, {
      entry: { name, path, is_dir: isDirectory },
      depth: dir === "/notes" ? 0 : 1,
      expanded: false,
    }))
    return path
  }

  return <div style={{ display: "flex", height: 480, width: 600 }}>
    <div style={{ display: "flex", width: 280, height: "100%" }}>
      <FileTree
        folder="/notes"
        rows={rows}
        activePath={null}
        onSearch={() => {}}
        onOpenFile={() => {}}
        onToggleDir={path => { if (path === DRAFTS) toggleDrafts() }}
        onCreateFile={createEntry("create-file")}
        onCreateFolder={createEntry("create-folder")}
        onSuggestName={async kind => kind === "create-file"
          ? "untitled-2.md" : "untitled-folder"}
        onEditError={setEditError}
        onRename={async (entry, rawName) => {
          await Promise.resolve()
          if (rawName === "delayed-error.md") {
            await new Promise<void>(resolve => { pendingRenameRef.current = resolve })
            throw new Error("Delayed rename failed.")
          }
          if (rawName === "taken.md") throw new Error("Name already exists.")
          const name = rawName.endsWith(`.${MARKDOWN_FILE_EXTENSION}`)
            ? rawName : `${rawName}.${MARKDOWN_FILE_EXTENSION}`
          const path = `${entry.path.slice(0, entry.path.lastIndexOf("/"))}/${name}`
          setRows(current => current.map(row => row.entry.path === entry.path
            ? { ...row, entry: { ...row.entry, name, path } } : row))
          return path
        }}
      />
    </div>
    <button type="button" style={{ alignSelf: "start", margin: 16 }}>Outside the tree</button>
    <button type="button" onClick={() => pendingRenameRef.current?.()}>Finish rename</button>
    {editError ? <span role="alert">{editError}</span> : null}
  </div>
}

createRoot(document.getElementById("host")!).render(<Harness />)
