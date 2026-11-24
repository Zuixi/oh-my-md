import type { CSSProperties } from "react"
import { FileTree } from "./FileTree"
import { SearchPanel } from "./SearchPanel"
import { SidebarResizer } from "./SidebarResizer"
import type { TreeEntry, VisibleRow } from "./fileTreeState"
import type { DesktopServices } from "./desktopServices"
import type { WorkspaceSearchState } from "./useWorkspaceSearch"
import type { SearchHit } from "./SearchPanel"

/**
 * Primary sidebar: the workspace search panel, or the file tree, plus its
 * resizer. Rendered as a fragment so the workspace DOM order is unchanged.
 */
export function AppSidebar(props: {
  readonly services: DesktopServices
  readonly open: boolean
  readonly width: number
  readonly folder: string | null
  readonly rows: VisibleRow[]
  readonly activePath: string | null
  readonly activeTabId: number
  readonly search: WorkspaceSearchState
  readonly onResize: (width: number) => void
  readonly onCommitWidth: (width: number) => void
  readonly onResetWidth: () => void
  readonly onOpenHit: (hit: SearchHit) => void
  readonly onOpenFile: (path: string) => void
  readonly onToggleDir: (path: string) => void
  readonly onSearch: () => void
  readonly onCreateFile?: (dir: string, name: string) => Promise<string>
  readonly onCreateFolder?: (dir: string, name: string) => Promise<string>
  readonly onSuggestName?: (kind: "create-file" | "create-folder", dir: string) => Promise<string>
  readonly onRename?: (entry: TreeEntry, name: string) => Promise<string>
  readonly onEditError: (message: string) => void
  readonly onDelete: (entry: TreeEntry) => void
  readonly onReveal: (path: string) => void
  readonly onCollapse: () => void
}) {
  const { search } = props
  return (
    <>
      <aside
        id="primary-sidebar"
        className={`sidebar-primary${props.open ? "" : " is-hidden"}`}
        style={{ "--omd-sidebar-width": `${props.width}px` } as CSSProperties}
        aria-hidden={!props.open}
        inert={!props.open}
      >
        {search.open ? (
          <SearchPanel
            query={search.query}
            hits={search.hits}
            truncated={search.truncated}
            caseSensitive={search.caseSensitive}
            onQuery={search.setQuery}
            onCaseSensitive={search.setCaseSensitive}
            onClose={() => search.setOpen(false)}
            onOpen={props.onOpenHit}
          />
        ) : (
          <FileTree
            folder={props.folder}
            rows={props.rows}
            activePath={props.activePath}
            activeTabId={props.activeTabId}
            visible={props.open}
            onOpenFile={props.onOpenFile}
            onToggleDir={props.onToggleDir}
            onSearch={props.onSearch}
            onCreateFile={props.onCreateFile}
            onCreateFolder={props.onCreateFolder}
            onSuggestName={props.onSuggestName}
            onRename={props.onRename}
            onEditError={props.onEditError}
            onDelete={props.onDelete}
            onReveal={props.onReveal}
            onCollapse={props.onCollapse}
          />
        )}
      </aside>
      {props.open ? (
        <SidebarResizer
          width={props.width}
          onResize={props.onResize}
          onCommit={props.onCommitWidth}
          onReset={props.onResetWidth}
        />
      ) : null}
    </>
  )
}
