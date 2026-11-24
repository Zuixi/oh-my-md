/**
 * External-change watching: the file tree's fallback poll, the open-tab disk
 * poll, native filesystem events, and the native watch set.
 *
 * Native notify events are the primary channel; the interval is only a safety
 * net for dropped events. `watchMs === 0` disables polling entirely (tests).
 */
import { useEffect, useRef } from "react"
import type { DesktopServices } from "./desktopServices"
import type { EditorSession } from "./session"
import { sessionContentLoaded, sessionPath } from "./session"
import { emptyFileTree, setChildren, type FileTreeModel, type TreeEntry } from "./fileTreeState"
import { pathWithinDir } from "./workspace"

export interface WorkspaceTreeActions {
  readonly refreshTree: (listDir: (path: string) => Promise<TreeEntry[]>) => Promise<void>
  readonly clearTreeError: (path: string) => void
  readonly reportTreeError: (path: string, error: unknown) => void
}

export interface WorkspaceWatcherHost {
  readonly services: DesktopServices
  readonly watchMs: number
  readonly folder: string | null
  readonly tabs: readonly EditorSession[]
  /** The Search panel replaces the tree; polling it would be pure waste. */
  readonly searchOpen: boolean
  readonly treeActions: WorkspaceTreeActions
  /** Commits a fresh tree model (App keeps the model in React state). */
  readonly commitTree: (next: FileTreeModel) => void
  /** Reads every open file tab and reconciles conflicts/disk changes. */
  readonly pollFileTabs: () => Promise<void>
}

interface FolderAuthEntry {
  readonly folder: string
  readonly ready: Promise<void>
}

/**
 * `treeActions` is rebuilt on every render but its methods only touch internal
 * refs, so the effects read the latest instance through a ref instead of
 * re-subscribing (which would drop and re-add the native listener each render).
 */
export function useWorkspaceWatcher(host: WorkspaceWatcherHost): void {
  const latest = useRef(host)
  latest.current = host
  const { services, watchMs, folder, tabs, searchOpen } = host
  const pollInFlightRef = useRef(false)
  // Share one authorization promise per folder so `listDir` and `watchPaths`
  // both wait for `allowWorkspaceDir` without issuing duplicate IPC calls.
  const folderAuthRef = useRef<FolderAuthEntry | null>(null)

  const ensureFolderAuthorized = (targetFolder: string): Promise<void> => {
    const cached = folderAuthRef.current
    if (cached?.folder === targetFolder) return cached.ready
    const entry: FolderAuthEntry = {
      folder: targetFolder,
      // A rejected grant must not stay cached: keeping it would both hide the
      // error and block every retry until this window is destroyed. Evict only
      // this attempt, so a newer folder's grant survives.
      ready: Promise.resolve(services.allowWorkspaceDir?.(targetFolder)).then(
        () => undefined,
        error => {
          if (folderAuthRef.current === entry) folderAuthRef.current = null
          throw error
        },
      ),
    }
    folderAuthRef.current = entry
    return entry.ready
  }

  /** `refreshTree` awaits this before every listing, so each refresh retries a
   *  grant that failed earlier instead of staying unauthorized for the session. */
  const authorizedListDir = (
    targetFolder: string,
    listDir: (path: string) => Promise<TreeEntry[]>,
  ) => (dir: string): Promise<TreeEntry[]> =>
    ensureFolderAuthorized(targetFolder).then(() => listDir(dir))

  // Poll rounds overlap on Windows (recursive folder watch + per-file watch);
  // one in-flight round is enough for every consumer.
  const runPoll = (): Promise<void> => {
    if (pollInFlightRef.current) return Promise.resolve()
    pollInFlightRef.current = true
    return latest.current.pollFileTabs().finally(() => { pollInFlightRef.current = false })
  }

  useEffect(() => {
    if (!folder || !services.listDir) return
    let cancelled = false
    const listDir = services.listDir
    latest.current.commitTree(emptyFileTree())
    // Authorize first: list_dir only serves directories this window was granted.
    void ensureFolderAuthorized(folder).then(() => listDir(folder)).then(entries => {
      if (cancelled) return
      latest.current.treeActions.clearTreeError(folder)
      latest.current.commitTree(setChildren(emptyFileTree(), folder, entries))
    }).catch(error => {
      if (!cancelled) latest.current.treeActions.reportTreeError(folder, error)
    })
    return () => { cancelled = true }
  }, [folder, services])

  useEffect(() => {
    // Skip the whole poll while Search replaces the tree: the scan is pure
    // waste and its results are not rendered.
    if (!watchMs || !folder || !services.listDir || searchOpen) return
    const refresh = authorizedListDir(folder, services.listDir)
    const timer = window.setInterval(() => {
      void latest.current.treeActions.refreshTree(refresh)
    }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs, folder, services, searchOpen])

  useEffect(() => {
    if (!watchMs) return
    const timer = window.setInterval(() => { void runPoll() }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs])

  useEffect(() => {
    if (!services.listenWorkspaceChange) return
    return services.listenWorkspaceChange(() => {
      void runPoll()
      const listDir = services.listDir
      const current = latest.current
      if (listDir && current.folder && !current.searchOpen) {
        void current.treeActions.refreshTree(authorizedListDir(current.folder, listDir))
      }
    })
  }, [services])

  // Keep Rust's watch set in sync with the folder and loaded open files outside it.
  // Wait for the folder grant first so `watch_paths` sees the authorized workspace root.
  useEffect(() => {
    const watchPaths = services.watchPaths
    if (!watchPaths) return
    let cancelled = false
    const paths = new Set<string>()
    if (folder) paths.add(folder)
    for (const tab of tabs) {
      if (!sessionContentLoaded(tab)) continue
      const path = sessionPath(tab)
      if (path && (!folder || !pathWithinDir(path, folder))) paths.add(path)
    }
    const targetPaths = [...paths]
    if (!folder) {
      void watchPaths(targetPaths)
      return
    }
    void ensureFolderAuthorized(folder).then(() => {
      if (!cancelled) void watchPaths(targetPaths)
    }).catch(() => {
      // An unauthorized root cannot be watched; watching the files outside it
      // is still useful, and the rejection must never surface as unhandled.
      if (cancelled) return
      const fallback = targetPaths.filter(path => path !== folder)
      if (fallback.length > 0) void watchPaths(fallback)
    })
    return () => { cancelled = true }
  }, [folder, tabs, services])
}
