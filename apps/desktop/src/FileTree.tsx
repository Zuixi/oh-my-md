import { useRef } from "react"
import { FilePlus, FolderOpen, FolderPlus, PanelLeftClose, Search } from "lucide-react"
import type { CreateKind, VisibleRow } from "./fileTreeState"
import { baseName } from "./workspace"
import { shortcutFor } from "./shortcuts"
import { useT } from "./i18n"
import { FileTreeTree, type FileTreeTreeHandle } from "./FileTreeTree"

export type { TreeEntry } from "./fileTreeState"

/**
 * Sidebar shell: heading with quick create actions, search entry point, and
 * the virtualized tree body. The tree body owns row rendering, keyboard
 * navigation, inline edits and the context menu (see `FileTreeTree.tsx`); this
 * component decides whether a folder is open.
 */
export function FileTree(props: {
  folder: string | null
  rows: VisibleRow[]
  activePath: string | null
  activeTabId?: number
  visible?: boolean
  dirtyPaths?: ReadonlySet<string>
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onSearch: () => void
  onOpenFolder?: () => void
  onCreateFile?: (dir: string, name: string) => Promise<string>
  onCreateFolder?: (dir: string, name: string) => Promise<string>
  onSuggestName?: (kind: CreateKind, dir: string) => Promise<string>
  onRename?: (entry: VisibleRow["entry"], name: string) => Promise<string>
  onEditError?: (message: string) => void
  onDelete?: (entry: VisibleRow["entry"]) => void
  onReveal?: (path: string) => void
  onCollapse?: () => void
}) {
  const t = useT()
  const treeRef = useRef<FileTreeTreeHandle | null>(null)
  const title = props.folder ? baseName(props.folder) : t("filetree.title.fallback")
  // The shortcut hint is part of the control's visible text, so the accessible
  // name has to contain it (WCAG 2.5.3 "label in name"); `aria-keyshortcuts`
  // exposes the binding to assistive tech as well.
  const searchShortcut = shortcutFor("search") ?? ""
  const hasCreateActions = Boolean(props.folder && (props.onCreateFile || props.onCreateFolder))
  return (
    <aside className="filetree">
      <div className="sidebar-title">
        <div className="sidebar-title-left">
          {props.onCollapse ? (
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={props.onCollapse}
              aria-label={t("filetree.aria.hideSidebar")}
              title={t("filetree.title.hideSidebar", { shortcut: shortcutFor("sidebar") ?? "" })}
            >
              <PanelLeftClose size={16} aria-hidden="true" />
            </button>
          ) : null}
          <span className="sidebar-title-text" title={props.folder ?? undefined}>{title}</span>
        </div>
        {hasCreateActions ? (
          <div className="sidebar-header-actions">
            {props.onCreateFile ? (
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={() => treeRef.current?.beginCreate("create-file")}
                aria-label={t("filetree.aria.newFile")}
                title={t("filetree.menu.newFile")}
              >
                <FilePlus size={14} aria-hidden="true" />
              </button>
            ) : null}
            {props.onCreateFolder ? (
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={() => treeRef.current?.beginCreate("create-folder")}
                aria-label={t("filetree.aria.newFolder")}
                title={t("filetree.menu.newFolder")}
              >
                <FolderPlus size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.folder ? (
        <div className="filetree-search-bar">
          <button
            type="button"
            className="filetree-search-btn"
            onClick={props.onSearch}
            aria-label={t("filetree.aria.search", { shortcut: searchShortcut })}
            aria-keyshortcuts={searchShortcut || undefined}
          >
            <Search size={13} className="filetree-search-icon" aria-hidden="true" />
            <span>{t("filetree.searchInFolder")}</span>
            <kbd aria-hidden="true">
              {t("filetree.kbd.searchShortcut", { shortcut: searchShortcut })}
            </kbd>
          </button>
        </div>
      ) : null}
      {!props.folder ? (
        <div className="sidebar-empty-state">
          <FolderOpen size={24} className="sidebar-empty-icon" aria-hidden="true" />
          <p className="sidebar-empty">{t("filetree.empty")}</p>
          {props.onOpenFolder ? (
            <button
              type="button"
              className="sidebar-empty-cta"
              onClick={props.onOpenFolder}
            >
              {t("filetree.openFolder")}
            </button>
          ) : null}
        </div>
      ) : (
        <FileTreeTree
          ref={treeRef}
          key={props.folder}
          folder={props.folder}
          rows={props.rows}
          activePath={props.activePath}
          activeTabId={props.activeTabId}
          visible={props.visible}
          dirtyPaths={props.dirtyPaths}
          onOpenFile={props.onOpenFile}
          onToggleDir={props.onToggleDir}
          onCreateFile={props.onCreateFile}
          onCreateFolder={props.onCreateFolder}
          onSuggestName={props.onSuggestName}
          onRename={props.onRename}
          onEditError={props.onEditError}
          onDelete={props.onDelete}
          onReveal={props.onReveal}
        />
      )}
    </aside>
  )
}
