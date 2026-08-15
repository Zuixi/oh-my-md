import { ChevronRight, FileText, PanelLeft, Plus, Settings, X } from "lucide-react"
import { sessionLabel, sessionPath, type EditorSession } from "./session"

export function TopBar(props: {
  workspace: string | null
  filePath: string | null
  dirty: boolean
  tabs: EditorSession[]
  activeId: number
  dirtyIds: number[]
  conflictIds: number[]
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  onFocusTab: (id: number) => void
  onCloseTab: (id: number) => void
  onNewTab: () => void
  onOpenSettings?: () => void
}) {
  const workspaceName = props.workspace
    ? props.workspace.replace(/\\/g, "/").split("/").pop() || "Workspace"
    : null

  const breadcrumb = buildBreadcrumb(props.workspace, props.filePath)

  return (
    <header className="topbar" data-tauri-drag-region="">
      {!props.sidebarOpen && props.onToggleSidebar ? (
        <div className="topbar-sidebar-toggle-wrapper">
          <button
            type="button"
            className="topbar-sidebar-toggle"
            onClick={props.onToggleSidebar}
            aria-label="Show sidebar"
            title="Show sidebar (⌘\)"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <span className="topbar-sidebar-divider" aria-hidden="true" />
        </div>
      ) : null}
      <div className="topbar-tabs" data-tauri-drag-region="">
        {props.tabs.map(tab => {
          const isActive = tab.id === props.activeId
          const isDirty = props.dirtyIds.includes(tab.id)
          const hasConflict = props.conflictIds.includes(tab.id)
          const path = sessionPath(tab)
          return (
            <button
              key={tab.id}
              type="button"
              className={isActive ? "tab is-active" : "tab"}
              onClick={() => props.onFocusTab(tab.id)}
              title={path ?? "unnamed"}
            >
              <FileText size={13} className="tab-icon" aria-hidden="true" />
              <span className={isActive ? "tab-title topbar-file" : "tab-title"}>
                {sessionLabel(tab)}
              </span>
              {isDirty ? (
                <span
                  className="tab-dirty"
                  aria-label={isActive ? "Unsaved" : undefined}
                >
                  •
                </span>
              ) : null}
              {hasConflict ? (
                <span className="tab-conflict" aria-label="Conflict">
                  !
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={-1}
                className="tab-close"
                aria-label="Close tab"
                onClick={event => {
                  event.stopPropagation()
                  props.onCloseTab(tab.id)
                }}
              >
                <X size={12} aria-hidden="true" />
              </span>
            </button>
          )
        })}
        <button
          type="button"
          className="tab-new"
          aria-label="+"
          title="New tab"
          onClick={props.onNewTab}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="topbar-actions" data-tauri-drag-region="">
        {breadcrumb.length > 0 && workspaceName ? (
          <div className="topbar-breadcrumb">
            <span className="topbar-workspace">{workspaceName}</span>
            {breadcrumb.map((segment, i) => (
              <span key={i} className="topbar-segment">
                <ChevronRight size={11} className="topbar-separator" aria-hidden="true" />
                <span className="topbar-dir">{segment}</span>
              </span>
            ))}
          </div>
        ) : null}
        {props.onOpenSettings ? (
          <button
            type="button"
            className="topbar-action-btn"
            onClick={props.onOpenSettings}
            aria-label="Preferences"
            title="Preferences (⌘,)"
          >
            <Settings size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  )
}

function buildBreadcrumb(workspace: string | null, filePath: string | null): string[] {
  if (!filePath) return []
  const normalized = filePath.replace(/\\/g, "/")
  if (workspace) {
    const root = workspace.replace(/\\/g, "/")
    if (normalized.startsWith(root + "/")) {
      return normalized.slice(root.length + 1).split("/")
    }
  }
  const name = normalized.split("/").pop()
  return name ? [name] : []
}
