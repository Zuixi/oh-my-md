import { useEffect, useRef, useState } from "react"
import {
  ENTRY_NAME_PROBLEM_KEYS, hasDuplicateName, prepareEntryName, suggestEntryName,
  type EntryKind,
} from "./entryName"
import {
  TreeEditError, type CreateKind, type TreeEntry, type VisibleRow,
} from "./fileTreeState"
import { fileNamesAreCaseInsensitive } from "./platform"
import { parentDir, pathWithinDir, samePath } from "./workspace"
import { useT } from "./i18n"

/** Inputs the inline edit row renders; one session exists at a time. */
export interface TreeEdit {
  readonly id: number
  readonly kind: "rename" | CreateKind
  /** Present only for rename. */
  readonly entry: TreeEntry | null
  /** Create target directory; empty for rename. */
  readonly dir: string
  /** Child depth of the draft row (create only). */
  readonly depth: number
  readonly draft: string
  /** True once the user typed; async suggestions must not overwrite it. */
  readonly touched: boolean
  /** Bumped when the draft is replaced externally, to re-select in the input. */
  readonly selectVersion: number
  readonly submitting: boolean
  readonly error: string | null
}

export const EDIT_INPUT_CLASS = "filetree-edit-input"

export interface TreeEditSessionOptions {
  folder: string
  rows: readonly VisibleRow[]
  visible?: boolean
  activePath: string | null
  activeTabId?: number
  onRename?: (entry: TreeEntry, name: string) => Promise<string>
  onCreateFile?: (dir: string, name: string) => Promise<string>
  onCreateFolder?: (dir: string, name: string) => Promise<string>
  onSuggestName?: (kind: CreateKind, dir: string) => Promise<string>
  /** Errors that leave the row and surface as an app notification. */
  onEditError?: (message: string) => void
  /** Called after a create lands, so the tree can reveal and select the node. */
  onCommitted?: (path: string, kind: CreateKind) => void
  /** Requests row focus (used after rename/cancel, never on blur). */
  onFocusRow?: (path: string) => void
}

export interface TreeEditSession {
  readonly edit: TreeEdit | null
  readonly notice: string | null
  beginRename(entry: TreeEntry): void
  beginCreate(kind: CreateKind, dir: string, depth: number): void
  changeDraft(value: string): void
  submit(): Promise<void>
  /** Escape restores row focus; blur and external dismissals do not. */
  cancel(restoreFocus: boolean): void
  dismiss(): void
}

/**
 * Inline rename/create session for the file tree. All disk writes are explicit:
 * only `submit()` calls the App callbacks; Escape, blur, and tab/sidebar
 * changes discard the draft without touching the filesystem.
 */
export function useTreeEditSession(options: TreeEditSessionOptions): TreeEditSession {
  const t = useT()
  const [edit, setEdit] = useState<TreeEdit | null>(null)
  const editRef = useRef<TreeEdit | null>(null)
  const nextEditId = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)

  // Syncing the ref in the same tick is both the submit lock and the guard
  // that isolates async completions from a superseded edit session.
  function update(next: TreeEdit | null) {
    editRef.current = next
    setEdit(next)
  }

  function dismiss() {
    if (!editRef.current) return
    update(null)
  }

  useEffect(() => () => { editRef.current = null }, [])

  useEffect(() => {
    if (options.visible === false) dismiss()
  }, [options.visible])

  const activePathRef = useRef(options.activePath)
  useEffect(() => {
    if (activePathRef.current === options.activePath) return
    activePathRef.current = options.activePath
    if (!editRef.current?.submitting) dismiss()
  }, [options.activePath])

  const activeTabIdRef = useRef(options.activeTabId)
  useEffect(() => {
    if (activeTabIdRef.current === options.activeTabId) return
    activeTabIdRef.current = options.activeTabId
    dismiss()
  }, [options.activeTabId])

  // A tree refresh can drop the edited node (deleted elsewhere) or the create
  // target. Collapsed ancestors only hide rows temporarily, so they do not
  // count as missing; re-expanding restores the same draft.
  //
  // `edit` is intentionally not a dependency: reading it through the ref lets
  // draft typing (which replaces `edit` on every keystroke) skip the O(rows)
  // scans. Sessions always start from a visible row, so the check is only
  // needed when the rows themselves change.
  useEffect(() => {
    const current = editRef.current
    if (!current || current.submitting) return
    if (current.kind === "rename") {
      const entry = current.entry
      if (!entry || !isRowGone(entry.path, options.rows)) return
      update(null)
      setNotice(t("filetree.rename.missing"))
      return
    }
    if (samePath(current.dir, options.folder)) return
    if (!isRowGone(current.dir, options.rows)) return
    update(null)
    setNotice(t("filetree.create.missing"))
  }, [options.rows, options.folder, t])

  function beginRename(entry: TreeEntry) {
    if (editRef.current?.submitting) return
    setNotice(null)
    update({
      id: ++nextEditId.current,
      kind: "rename",
      entry,
      dir: "",
      depth: 0,
      draft: entry.name,
      touched: false,
      selectVersion: 0,
      submitting: false,
      error: null,
    })
  }

  function beginCreate(kind: CreateKind, dir: string, depth: number) {
    const create = kind === "create-file" ? options.onCreateFile : options.onCreateFolder
    if (!create || editRef.current?.submitting) return
    setNotice(null)
    const id = ++nextEditId.current
    update({
      id,
      kind,
      entry: null,
      dir,
      depth,
      draft: suggestEntryName(entryKind(kind), []),
      touched: false,
      selectVersion: 0,
      submitting: false,
      error: null,
    })
    void applySuggestion(kind, dir, id)
  }

  async function applySuggestion(kind: CreateKind, dir: string, id: number) {
    if (!options.onSuggestName) return
    let suggested: string
    try {
      suggested = await options.onSuggestName(kind, dir)
    } catch {
      // The prefilled base name is a complete fallback; suggestion failure
      // must not become a creation failure or a toast.
      return
    }
    const current = editRef.current
    if (!current || current.id !== id || current.kind !== kind) return
    if (current.touched || current.submitting || current.draft === suggested) return
    update({ ...current, draft: suggested, selectVersion: current.selectVersion + 1 })
  }

  function changeDraft(value: string) {
    const current = editRef.current
    if (!current || current.submitting) return
    update({ ...current, draft: value, touched: true, error: null })
  }

  function cancel(restoreFocus: boolean) {
    const current = editRef.current
    if (!current || current.submitting) return
    if (restoreFocus) options.onFocusRow?.(cancelFocusPath(current))
    update(null)
  }

  async function submit(): Promise<void> {
    const current = editRef.current
    if (!current || current.submitting) return
    const folder = isFolderEdit(current)
    const prepared = prepareEntryName(current.draft, folder ? "folder" : "file", {
      keepMarkdownExtension: current.kind === "rename",
    })
    if (prepared.problem) {
      update({ ...current, error: t(ENTRY_NAME_PROBLEM_KEYS[prepared.problem]) })
      return
    }
    // Rust's rename collision errors are localized OS messages, so a visible
    // sibling collision must be caught here to stay inline and consistent.
    if (duplicateSibling(current, prepared.name)) {
      update({ ...current, error: t("filetree.create.exists", { name: prepared.name }) })
      return
    }

    update({ ...current, submitting: true, error: null })
    try {
      const path = current.kind === "rename" && current.entry
        ? await rename(current, prepared.name)
        : await create(current, prepared.name)
      if (editRef.current?.id !== current.id) return
      if (current.kind === "rename") finishRename(current, path)
      else finishCreate(current, path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (editRef.current?.id !== current.id) {
        options.onEditError?.(message)
        return
      }
      // Create IO failures leave the row (toast); name problems stay inline.
      if (current.kind !== "rename" && error instanceof TreeEditError && error.kind === "io") {
        update({ ...current, submitting: false, error: null })
        options.onEditError?.(message)
        return
      }
      update({ ...current, submitting: false, error: message })
    }
  }

  function rename(current: TreeEdit, name: string): Promise<string> {
    if (!options.onRename || !current.entry) return Promise.reject(new Error(t("error.renameFailed")))
    return options.onRename(current.entry, name)
  }

  function create(current: TreeEdit, name: string): Promise<string> {
    const createEntry = current.kind === "create-file" ? options.onCreateFile : options.onCreateFolder
    if (!createEntry) {
      const key = current.kind === "create-file" ? "error.createFileFailed" : "error.createFolderFailed"
      return Promise.reject(new TreeEditError("io", t(key)))
    }
    return createEntry(current.dir, name)
  }

  function finishRename(current: TreeEdit, path: string) {
    if (editRef.current?.id !== current.id) return
    // Do not steal focus the user moved during the request (editor, another
    // field). Losing the input because the refreshed tree renamed its row
    // leaves focus on <body>, which still counts as "the edit owned it".
    if (editOwnsFocus()) options.onFocusRow?.(path)
    update(null)
  }

  function finishCreate(current: TreeEdit, path: string) {
    if (editRef.current?.id !== current.id) return
    update(null)
    options.onCommitted?.(path, current.kind as CreateKind)
  }

  /**
   * Whether a sibling in the edit's target directory already uses `candidate`.
   * Rename excludes the entry itself so case-only renames still reach disk;
   * Rust stays authoritative for collisions the visible rows cannot show.
   */
  function duplicateSibling(current: TreeEdit, candidate: string): boolean {
    const dir = current.kind === "rename"
      ? (current.entry ? parentDir(current.entry.path) : null)
      : current.dir
    if (dir === null) return false
    const exclude = current.kind === "rename" ? current.entry?.path ?? null : null
    const names: string[] = []
    for (const row of options.rows) {
      if (exclude !== null && samePath(row.entry.path, exclude)) continue
      const parent = parentDir(row.entry.path)
      if (parent !== null && samePath(parent, dir)) names.push(row.entry.name)
    }
    return hasDuplicateName(names, candidate, fileNamesAreCaseInsensitive())
  }

  return {
    edit,
    notice,
    beginRename,
    beginCreate,
    changeDraft,
    submit,
    cancel,
    dismiss,
  }
}

function entryKind(kind: CreateKind): EntryKind {
  return kind === "create-file" ? "file" : "folder"
}

function isFolderEdit(edit: TreeEdit): boolean {
  return edit.kind === "create-folder" || edit.entry?.is_dir === true
}

function cancelFocusPath(edit: TreeEdit): string {
  return edit.kind === "rename" && edit.entry ? edit.entry.path : edit.dir
}

/**
 * Whether the edit input still owns (or effectively owned) focus. A refreshed
 * tree can unmount the renamed row before the rename completes, dropping focus
 * to <body> even though the user never moved it; only a real focus target
 * elsewhere (editor, another field) suppresses the post-rename row focus.
 */
function editOwnsFocus(): boolean {
  const active = document.activeElement
  if (active === null || active === document.body || active === document.documentElement) return true
  return active instanceof HTMLElement && active.classList.contains(EDIT_INPUT_CLASS)
}

/** True when a refresh no longer shows `path` and no collapsed ancestor hides it. */
function isRowGone(path: string, rows: readonly VisibleRow[]): boolean {
  const present = rows.some(row => samePath(row.entry.path, path))
  if (present) return false
  return !rows.some(row =>
    row.entry.is_dir && !row.expanded && pathWithinDir(path, row.entry.path))
}
