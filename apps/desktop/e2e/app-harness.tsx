// Full-App e2e harness: mounts the real desktop <App> in a plain browser page
// with an in-memory DesktopServices double. No Tauri IPC, no happy-dom stand-in:
// a real Chromium user journey (open → edit → save, conflict diff, snapshot
// restore, media lightbox, ARIA invariants) runs against the shipped shell.
import { createRoot } from "react-dom/client"
import App from "../src/App"
import type { DesktopServices, SnapshotEntry } from "../src/desktopServices"
import type { TreeEntry } from "../src/fileTreeState"
import type { SearchHit } from "../src/SearchPanel"
import type { SavedSessionState } from "../src/sessionRestore"
import type { UpdateAdapter } from "../src/updateAdapter"
import { DEFAULT_SETTINGS, type UserSettings } from "../src/settings"
import { setLocale } from "../src/i18n"
import { makeFakeDisk } from "../test/fakeDisk"
import "../src/styles.css"

const WORKSPACE = "/notes"
const WELCOME_PATH = `${WORKSPACE}/welcome.md`
const ROADMAP_PATH = `${WORKSPACE}/roadmap.md`
const COPY_PATH = `${WORKSPACE}/copy.md`
const NOTE_NAMES = ["roadmap.md", "welcome.md"] as const

const WELCOME_DOC = [
  "# Welcome",
  "",
  "Paragraph in welcome note.",
  "",
  '![Sample diagram](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mNk+M9QzwAEjDAGACCcAwb3t2wGAAAAAElFTkSuQmCC "Sample diagram")',
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| Alpha | 1 |",
  "",
].join("\n")

const ROADMAP_DOC = "# Roadmap\n\nInitial roadmap plan.\n"
const SNAPSHOT_FILE = "1700000000001.md"
const SNAPSHOT_MTIME_MS = 1700000000001
const SNAPSHOT_BYTES = 2048
const SNAPSHOT_TEXT = "# Roadmap\n\nRestored snapshot milestone.\n"
// 60s keeps autosave out of the way; every spec saves explicitly.
const AUTOSAVE_MS = 60_000
// 0 disables the fallback disk poll; native events are not available here.
const WATCH_MS = 0
// 0 materializes synchronously so a save never reads a stale buffer.
const DOC_MATERIALIZE_MS = 0

interface SavedEntry {
  readonly path: string
  readonly contents: string
}

interface SeededSnapshot {
  readonly entry: SnapshotEntry
  readonly contents: string
}

export interface AppTestHandle {
  readDisk(path: string): string | null
  setDiskExternal(path: string, contents: string): void
  savedHistory(): readonly SavedEntry[]
  runMenuCommand(id: string): void
  errors(): readonly string[]
}

declare global {
  interface Window {
    __omdAppTest: AppTestHandle
  }
}

const params = new URLSearchParams(location.search)
setLocale("en")
document.documentElement.dataset.theme = params.get("theme") ?? "light"

const disk = makeFakeDisk()
disk.seed(WELCOME_PATH, WELCOME_DOC)
disk.seed(ROADMAP_PATH, ROADMAP_DOC)
const savedHistory: SavedEntry[] = []
const errors: string[] = []
const snapshotsByPath = new Map<string, SeededSnapshot[]>([
  [ROADMAP_PATH, [{
    entry: { fileName: SNAPSHOT_FILE, mtimeMs: SNAPSHOT_MTIME_MS, sizeBytes: SNAPSHOT_BYTES },
    contents: SNAPSHOT_TEXT,
  }]],
])
// Mutable in-memory host state: the app reads and writes it like the Tauri shard.
const memory: { session: SavedSessionState | null; settings: UserSettings } = {
  session: null,
  settings: { ...DEFAULT_SETTINGS },
}
// Effects register these once; the test handle drives them deterministically, so
// a menu item behaves the same on macOS and Linux (no accelerator guessing).
const listeners: { menu: ((id: string) => void) | null; workspace: ((paths: string[]) => void) | null } = {
  menu: null,
  workspace: null,
}
let snapshotSequence = 0

const noOpUpdateAdapter: UpdateAdapter = {
  check: async () => null,
  relaunch: async () => undefined,
}

function noteEntries(): TreeEntry[] {
  return NOTE_NAMES
    .map(name => ({ name, path: `${WORKSPACE}/${name}`, is_dir: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function searchNotes(root: string, query: string, caseSensitive = false): SearchHit[] {
  const hits: SearchHit[] = []
  if (!query) return hits
  const dir = root.replace(/\/+$/, "")
  const needle = caseSensitive ? query : query.toLowerCase()
  for (const name of NOTE_NAMES) {
    const path = `${dir}/${name}`
    const snapshot = disk.readDocument(path)
    if (snapshot.kind !== "existing") continue
    snapshot.contents.split("\n").forEach((text, index) => {
      const at = (caseSensitive ? text : text.toLowerCase()).indexOf(needle)
      if (at < 0) return
      hits.push({ path, line: index + 1, text, start: at, end: at + query.length })
    })
  }
  return hits
}

const services: DesktopServices = {
  getSessionState: async () => ({
    folder: WORKSPACE,
    openPaths: [WELCOME_PATH],
    activePath: WELCOME_PATH,
  }),
  saveSessionState: async state => { memory.session = state },
  // No `sidebarVisible` field exists: the shell reads its open/closed flag from
  // localStorage (default open), so DEFAULT_SETTINGS is the whole contract.
  getSettings: async () => ({ ...memory.settings }),
  saveSettings: async next => {
    memory.settings = next
    return true
  },
  allowWorkspaceDir: async () => undefined,
  allowDocumentAssets: async () => undefined,
  watchPaths: async () => undefined,
  listDir: async path => (path === WORKSPACE ? noteEntries() : []),
  listMarkdownFiles: async () => ({
    paths: [...NOTE_NAMES].map(name => `${WORKSPACE}/${name}`),
    truncated: false,
  }),
  searchMarkdown: async (root, query, caseSensitive) => ({
    hits: searchNotes(root, query, caseSensitive),
    truncated: false,
  }),
  readDocument: async path => disk.readDocument(path),
  readDocumentVersion: async path => disk.readDocumentVersion(path),
  saveDocument: async (path, contents, expected) => {
    const result = disk.saveDocument(path, contents, expected)
    if (result.status === "saved") savedHistory.push({ path, contents })
    return result
  },
  snapshotDocument: async path => {
    const snapshot = disk.readDocument(path)
    if (snapshot.kind !== "existing") return
    const now = Date.now()
    const list = snapshotsByPath.get(path) ?? []
    list.push({
      entry: {
        fileName: `${now}-${snapshotSequence++}.md`,
        mtimeMs: now,
        sizeBytes: snapshot.contents.length,
      },
      contents: snapshot.contents,
    })
    snapshotsByPath.set(path, list)
  },
  listSnapshots: async path =>
    (snapshotsByPath.get(path) ?? []).map(snapshot => snapshot.entry),
  readSnapshot: async (path, fileName) => {
    const found = (snapshotsByPath.get(path) ?? [])
      .find(snapshot => snapshot.entry.fileName === fileName)
    if (!found) throw new Error(`no snapshot ${fileName} for ${path}`)
    return found.contents
  },
  clearSnapshots: async path => { snapshotsByPath.delete(path) },
  pickOpenPath: async () => null,
  pickSavePath: async () => COPY_PATH,
  confirmDiscard: () => true,
  confirmClose: () => true,
  confirmExternalChange: () => false,
  listenMenu: handler => {
    listeners.menu = handler
    return () => { listeners.menu = null }
  },
  listenWorkspaceChange: handler => {
    listeners.workspace = handler
    return () => { listeners.workspace = null }
  },
  reportError: message => { errors.push(message) },
}

window.__omdAppTest = {
  readDisk: path => disk.disk(path).contents(),
  setDiskExternal: (path, contents) => { disk.disk(path).set(contents) },
  savedHistory: () => savedHistory,
  runMenuCommand: id => { listeners.menu?.(id) },
  errors: () => errors,
}

createRoot(document.getElementById("root")!).render(
  <App
    services={services}
    autosaveMs={AUTOSAVE_MS}
    watchMs={WATCH_MS}
    docMaterializeMs={DOC_MATERIALIZE_MS}
    updateAdapter={noOpUpdateAdapter}
  />,
)
