import { defaultServices, errorMessage, type DesktopServices } from "./desktopServices"
import {
  pathsToRefresh,
  removeTreePath,
  renameTreePath,
  replaceTreePrefix,
  setChildren,
  toggleExpand,
  type FileTreeModel,
  type TreeEntry,
} from "./fileTreeState"
import { MARKDOWN_FILE_EXTENSION } from "./constants"
import {
  findTabByPath,
  parentDir,
  pathWithinDir,
  type Workspace,
} from "./workspace"
import { recoveryKey, retargetSessionPath, sessionDirty, sessionPath, type EditorSession } from "./session"

export interface FileTreeHost {
  readonly services: DesktopServices
  getTreeModel(): FileTreeModel
  commitTree(next: FileTreeModel): void
  getWorkspace(): Workspace
  commitWorkspace(next: Workspace): void
  getContents(tabId: number): string
  flushMaterializer(): void
  isOpenInFlight(path: string): boolean
  invalidateOpen(path: string): void
  closeTab(id: number, options: { confirm: boolean; allowReplaceLast: boolean }): boolean
  saveRecovery(tab: EditorSession, contents: string): void
  notifySuccess(message: string): void
  reportError(message: string): void
  reportUserError(message: string): void
  t(key: string, params?: Record<string, string | number>): string
  confirmDiscard(): boolean
  confirmClose(): boolean | undefined
  confirmDelete(path: string): boolean | undefined
  isMounted(): boolean
  setPendingFocus(): void
  openPath(path: string, inNewTab?: boolean): Promise<void>
  /** 跨渲染可变协调状态（App refs）：错误签名去重、轮询 in-flight、
   * 在途列举目录。工厂每渲染重建，这些状态必须住在宿主 refs 里，
   * 否则重渲染即重置，去重与并发防护全部失效。 */
  readonly treeErrorSignatures: Map<string, string>
  readonly treePollInFlight: { current: boolean }
  readonly pendingListDirs: Set<string>
}

export interface FileTreeActions {
  readonly invalidName: (name: string) => boolean
  readonly normalizeMarkdownName: (name: string) => string
  readonly reportTreeError: (path: string, error: unknown) => void
  readonly clearTreeError: (path: string) => void
  readonly refreshTreePath: (path: string) => Promise<void>
  readonly refreshTree: (listDir: (path: string) => Promise<TreeEntry[]>) => Promise<void>
  readonly toggleDir: (path: string) => Promise<void>
  readonly expandToPath: (path: string) => Promise<void>
  readonly createTreeFile: (dir: string) => Promise<void>
  readonly createTreeFolder: (dir: string) => Promise<void>
  readonly renameTreeEntry: (entry: TreeEntry, rawName: string) => Promise<string>
  readonly deleteTreeEntry: (entry: TreeEntry) => Promise<void>
}

/** Shallow directory listing equality; a mismatch means disk changed. */
function sameEntries(
  a: readonly TreeEntry[] | undefined,
  b: readonly TreeEntry[],
): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name || a[i].path !== b[i].path || a[i].is_dir !== b[i].is_dir) {
      return false
    }
  }
  return true
}

export function createFileTreeActions(host: FileTreeHost): FileTreeActions {
  const { services } = host

  function invalidName(name: string): boolean {
    return (
      !name
      || name === "."
      || name === `.${MARKDOWN_FILE_EXTENSION}`
      || name.includes("/")
      || name.includes("\\")
      || name.includes("..")
    )
  }

  function normalizeMarkdownName(name: string): string {
    const trimmed = name.trim()
    return trimmed.toLowerCase().endsWith(`.${MARKDOWN_FILE_EXTENSION}`)
      ? trimmed
      : `${trimmed}.${MARKDOWN_FILE_EXTENSION}`
  }

  /** 列举错误签名经 host refs 保存（路径 → 上次已上报的错误文案）。
   * 通知语义：状态变化才打扰——同一路径的相同错误只报一次，
   * 列举成功清除签名，新错误形态仍会上报。 */
  const treeErrorSignatures = host.treeErrorSignatures
  const treePollInFlight = host.treePollInFlight
  const pendingListDirs = host.pendingListDirs

  function reportTreeError(path: string, error: unknown) {
    const message = errorMessage(host.t("error.folderListingFailed"), error)
    const signatures = treeErrorSignatures
    if (signatures.get(path) === message) return
    signatures.set(path, message)
    host.reportError(message)
  }

  function clearTreeError(path: string) {
    treeErrorSignatures.delete(path)
  }

  async function refreshTreePath(path: string): Promise<void> {
    if (!services.listDir) return
    const folder = host.getWorkspace().folder
    try {
      const entries = await services.listDir(path)
      if (!host.isMounted() || host.getWorkspace().folder !== folder) return
      clearTreeError(path)
      host.commitTree(setChildren(host.getTreeModel(), path, entries))
    } catch (error) {
      if (host.isMounted() && host.getWorkspace().folder === folder) reportTreeError(path, error)
    }
  }

  async function nextUntitledMarkdownName(dir: string): Promise<string> {
    if (!services.listDir) return `untitled.${MARKDOWN_FILE_EXTENSION}`
    const entries = await services.listDir(dir)
    const names = new Set(entries.map(entry => entry.name))
    if (!names.has(`untitled.${MARKDOWN_FILE_EXTENSION}`)) return `untitled.${MARKDOWN_FILE_EXTENSION}`
    let suffix = 2
    while (names.has(`untitled-${suffix}.${MARKDOWN_FILE_EXTENSION}`)) suffix += 1
    return `untitled-${suffix}.${MARKDOWN_FILE_EXTENSION}`
  }

  async function refreshTree(listDir: (path: string) => Promise<TreeEntry[]>): Promise<void> {
    const folder = host.getWorkspace().folder
    if (!folder || treePollInFlight.current) return
    treePollInFlight.current = true
    try {
      let next = host.getTreeModel()
      let changed = false
      for (const path of pathsToRefresh(folder, next)) {
        let entries: TreeEntry[]
        try {
          entries = await listDir(path)
        } catch {
          continue
        }
        // Skip re-rendering the whole tree when a directory is unchanged.
        if (sameEntries(next.childrenByPath[path], entries)) continue
        next = setChildren(next, path, entries)
        changed = true
      }
      if (changed) host.commitTree(next)
    } finally {
      treePollInFlight.current = false
    }
  }

  async function toggleDir(path: string): Promise<void> {
    const next = toggleExpand(host.getTreeModel(), path)
    host.commitTree(next)
    if (!next.expanded.has(path) || next.childrenByPath[path] || !services.listDir) return
    if (pendingListDirs.has(path)) return
    pendingListDirs.add(path)
    try {
      const entries = await services.listDir(path)
      // The user may have collapsed the directory while the listing was in
      // flight; caching it would only produce a useless model update.
      if (!host.getTreeModel().expanded.has(path)) return
      clearTreeError(path)
      host.commitTree(setChildren(host.getTreeModel(), path, entries))
    } catch (error) {
      reportTreeError(path, error)
    } finally {
      pendingListDirs.delete(path)
    }
  }

  /** Expands every ancestor of `path` down from the workspace root so the
   * opened file is reachable in the tree. Best-effort: a listing failure must
   * not block an open that already succeeded. */
  async function expandToPath(path: string): Promise<void> {
    const folder = host.getWorkspace().folder
    if (!folder || !services.listDir) return
    const dirs: string[] = []
    let current = parentDir(path)
    const prefix = folder === "/" ? folder : `${folder}/`
    while (current && current !== folder && current.startsWith(prefix)) {
      dirs.unshift(current)
      const above = parentDir(current)
      if (above === current) break
      current = above
    }
    for (const dir of dirs) {
      // Ensure the ancestor is expanded without toggling: the user may have
      // already opened it, and expandToPath must never collapse it.
      if (!host.getTreeModel().expanded.has(dir)) {
        host.commitTree(toggleExpand(host.getTreeModel(), dir))
      }
      if (host.getTreeModel().childrenByPath[dir] || pendingListDirs.has(dir)) continue
      pendingListDirs.add(dir)
      try {
        const entries = await services.listDir(dir)
        if (host.getTreeModel().expanded.has(dir)) {
          host.commitTree(setChildren(host.getTreeModel(), dir, entries))
        }
      } catch {
        // reveal is best-effort
      } finally {
        pendingListDirs.delete(dir)
      }
    }
  }

  async function createTreeFile(dir: string) {
    if (!services.createMarkdown) return
    let defaultName = `untitled.${MARKDOWN_FILE_EXTENSION}`
    try {
      defaultName = await nextUntitledMarkdownName(dir)
    } catch (error) {
      reportTreeError(dir, error)
      return
    }
    const rawName = window.prompt(host.t("filetree.prompt.newFile"), defaultName)
    if (rawName === null) return
    const name = normalizeMarkdownName(rawName)
    if (invalidName(name)) {
      host.reportUserError(host.t("error.emptyName"))
      return
    }
    try {
      const createdPath = await services.createMarkdown(dir, name)
      await refreshTreePath(dir)
      host.setPendingFocus()
      void host.openPath(createdPath, true)
      host.notifySuccess(host.t("notify.fileCreated", { name }))
    } catch (error) {
      host.reportError(errorMessage(host.t("error.createFileFailed"), error))
    }
  }

  async function createTreeFolder(dir: string) {
    if (!services.createDir) return
    const rawName = window.prompt(host.t("filetree.prompt.newFolder"), "untitled-folder")
    if (rawName === null) return
    const name = rawName.trim()
    if (invalidName(name)) {
      host.reportUserError(host.t("error.emptyName"))
      return
    }
    try {
      await services.createDir(dir, name)
      await refreshTreePath(dir)
    } catch (error) {
      host.reportError(errorMessage(host.t("error.createFolderFailed"), error))
    }
  }

  function retargetOpenTabs(from: string, to: string, isDir: boolean): void {
    const previousTabs = host.getWorkspace().tabs
    const nextTabs = previousTabs.map(tab => {
      const path = sessionPath(tab)
      if (!path) return tab
      const nextPath = replaceTreePrefix(path, from, to)
      if (nextPath !== path && (isDir || path.replace(/\\/g, "/") === from.replace(/\\/g, "/"))) {
        return retargetSessionPath(tab, nextPath)
      }
      return tab
    })
    if (nextTabs.every((tab, index) => tab === previousTabs[index])) return
    previousTabs.forEach((tab, index) => {
      const next = nextTabs[index]
      if (tab === next) return
      const oldKey = recoveryKey(tab)
      if (oldKey !== recoveryKey(next)) void services.clearRecovery?.(oldKey)
      const contents = host.getContents(next.id)
      if (contents !== undefined && sessionDirty(next, contents)) host.saveRecovery(next, contents)
    })
    host.commitWorkspace({ ...host.getWorkspace(), tabs: nextTabs })
    const affectedPaths = nextTabs
      .map(tab => sessionPath(tab))
      .filter((path): path is string => path !== null)
      .filter(path => path === to || (isDir && pathWithinDir(path, to)))
    for (const path of new Set(affectedPaths)) {
      void services.allowDocumentAssets(path).catch(error => {
        host.reportError(errorMessage(host.t("error.renameSyncFailed"), error))
      })
    }
  }

  async function renameTreeEntry(entry: TreeEntry, rawName: string): Promise<string> {
    if (!services.renamePath) throw new Error(host.t("error.renameFailed"))
    const name = entry.is_dir ? rawName.trim() : normalizeMarkdownName(rawName)
    if (name === entry.name) return entry.path
    if (invalidName(name)) throw new Error(host.t("error.emptyName"))
    const dir = parentDir(entry.path)
    if (!dir) throw new Error(host.t("error.renameFailed"))
    const folder = host.getWorkspace().folder
    let nextPath: string
    try {
      nextPath = await services.renamePath(entry.path, name)
    } catch (error) {
      throw new Error(errorMessage(host.t("error.renameFailed"), error))
    }
    if (!host.isMounted()) return nextPath
    // 原生操作已成功：目录刷新失败不能再被当作重命名失败供用户重试。
    try {
      if (host.getWorkspace().folder === folder) {
        host.commitTree(renameTreePath(host.getTreeModel(), entry.path, nextPath))
        void refreshTreePath(dir)
      }
      host.flushMaterializer()
      retargetOpenTabs(entry.path, nextPath, entry.is_dir)
    } catch (error) {
      host.reportError(errorMessage(host.t("error.renameSyncFailed"), error))
    }
    host.notifySuccess(host.t("notify.entryRenamed", { name }))
    return nextPath
  }

  async function deleteTreeEntry(entry: TreeEntry) {
    if (!services.deletePath) return
    // 脏检查前物化：250ms 窗口内的编辑必须被看见，否则跳过确认删文件丢内容（Spec 05a）。
    host.flushMaterializer()
    const openTab = !entry.is_dir ? findTabByPath(host.getWorkspace(), entry.path) : undefined
    if (
      openTab
      && sessionDirty(openTab, host.getContents(openTab.id))
      && !(host.confirmClose() ?? host.confirmDiscard())
    ) {
      return
    }
    const confirmDelete = (path: string): boolean =>
      host.confirmDelete(path) ?? (defaultServices.confirmDelete?.(path) ?? true)
    if (!confirmDelete(entry.path)) return
    try {
      await services.deletePath(entry.path)
      // 删除的 await 期间在途 openPath 可能把该文件的 tab 加进来：仅在有在途打开
      // 时登记作废（无条件登记会吞掉同名重建文件的首个打开），并在删除完成后重新
      // 查找要关的 tab（confirm 前的快照 openTab 已过期，只保留给脏检查用）。
      if (host.isOpenInFlight(entry.path)) host.invalidateOpen(entry.path)
      host.commitTree(removeTreePath(host.getTreeModel(), entry.path))
      const tabToClose = !entry.is_dir ? findTabByPath(host.getWorkspace(), entry.path) : undefined
      if (tabToClose) host.closeTab(tabToClose.id, { confirm: false, allowReplaceLast: true })
      const dir = parentDir(entry.path)
      if (dir) await refreshTreePath(dir)
      host.notifySuccess(host.t("notify.entryDeleted", { name: entry.name }))
    } catch (error) {
      host.reportError(errorMessage(host.t("error.deleteFailed"), error))
    }
  }

  return {
    invalidName,
    normalizeMarkdownName,
    reportTreeError,
    clearTreeError,
    refreshTreePath,
    refreshTree,
    toggleDir,
    expandToPath,
    createTreeFile,
    createTreeFolder,
    renameTreeEntry,
    deleteTreeEntry,
  }
}
