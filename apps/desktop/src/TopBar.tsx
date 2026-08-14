import { sessionLabel, type EditorSession } from "./session"

export function TopBar(props: {
  workspace: string | null
  filePath: string | null
  dirty: boolean
  tabs: EditorSession[]
  activeId: number
  dirtyIds: number[]
  conflictIds: number[]
  onFocusTab: (id: number) => void
  onCloseTab: (id: number) => void
  onNewTab: () => void
}) {
  const workspaceName = props.workspace
    ? props.workspace.replace(/\\/g, "/").split("/").pop() || "Workspace"
    : null

  const breadcrumb = buildBreadcrumb(props.workspace, props.filePath)

  return (
    <header className="topbar" data-tauri-drag-region="">
      <div className="topbar-breadcrumb" data-tauri-drag-region="">
        {workspaceName ? (
          <span className="topbar-workspace">{workspaceName}</span>
        ) : null}
        {breadcrumb.length > 0 ? (
          breadcrumb.map((segment, i) => (
            <span key={i} className="topbar-segment">
              <span className="topbar-separator" aria-hidden="true">/</span>
              <span className={i === breadcrumb.length - 1 ? "topbar-file" : "topbar-dir"}>
                {segment}
              </span>
            </span>
          ))
        ) : (
          <span className="topbar-segment">
            {workspaceName ? (
              <span className="topbar-separator" aria-hidden="true">/</span>
            ) : null}
            <span className="topbar-file">untitled</span>
          </span>
        )}
        {props.dirty ? <span className="topbar-dirty" aria-label="Unsaved">•</span> : null}
      </div>
      <div className="topbar-tabs">
        {props.tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === props.activeId ? "tab is-active" : "tab"}
            onClick={() => props.onFocusTab(tab.id)}
          >
            {sessionLabel(tab)}
            {props.dirtyIds.includes(tab.id) ? <span className="tab-dirty">•</span> : null}
            {props.conflictIds.includes(tab.id)
              ? <span className="tab-conflict" aria-label="Conflict">!</span>
              : null}
            <span
              className="tab-close"
              onClick={event => {
                event.stopPropagation()
                props.onCloseTab(tab.id)
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button type="button" className="tab-new" onClick={props.onNewTab}>+</button>
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
