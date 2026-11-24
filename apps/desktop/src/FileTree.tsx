import { PanelLeftClose, Search } from "lucide-react"
import type { CreateKind, VisibleRow } from "./fileTreeState"
import { baseName } from "./workspace"
import { shortcutFor } from "./shortcuts"
import { useT } from "./i18n"
import { FileTreeTree } from "./FileTreeTree"

export type { TreeEntry } from "./fileTreeState"

/**
 * Sidebar shell: heading, search entry point, and the virtualized tree body.
 * The tree body owns row rendering, keyboard navigation, inline edits and the
 * context menu (see `FileTreeTree.tsx`); this component only decides whether a
 * folder is open.
 */
export function FileTree(props: {
  folder: string | null
  rows: VisibleRow[]
  activePath: string | null
  activeTabId?: number
  visible?: boolean
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onSearch: () => void
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
  const title = props.folder ? baseName(props.folder) : t("filetree.title.fallback")
  // The shortcut hint is part of the control's visible text, so the accessible
  // name has to contain it (WCAG 2.5.3 "label in name"); `aria-keyshortcuts`
  // exposes the binding to assistive tech as well.
  const searchShortcut = shortcutFor("search") ?? ""
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
              <PanelLeftClose size={16} />
            </button>
          ) : null}
          <span className="sidebar-title-text">{title}</span>
        </div>
      </div>
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
      {!props.folder ? (
        <p className="sidebar-empty">{t("filetree.empty")}</p>
      ) : (
        <FileTreeTree
          key={props.folder}
          folder={props.folder}
          rows={props.rows}
          activePath={props.activePath}
          activeTabId={props.activeTabId}
          visible={props.visible}
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
