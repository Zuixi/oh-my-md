import { useEffect, useRef, type KeyboardEvent } from "react"
import { ChevronRight, FileText, PanelLeft, Plus, Settings, X } from "lucide-react"
import { sessionLabel, sessionPath, type EditorSession } from "./session"
import { baseName, pathWithinDir, relativeToDir } from "./workspace"
import { shortcutFor } from "./shortcuts"
import { useT } from "./i18n"

export function TopBar(props: {
  workspace: string | null
  filePath: string | null
  tabs: EditorSession[]
  activeId: number
  dirtyIds: readonly number[]
  conflictIds: readonly number[]
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  onFocusTab: (id: number) => void
  onCloseTab: (id: number) => void
  onNewTab: () => void
  onOpenSettings?: () => void
}) {
  const t = useT()
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  // Tabs overflow into a horizontal scroller; keep the active tab revealed when
  // activation moves (tab switch, close-and-slide-into-slot, palette open).
  useEffect(() => {
    const el = activeTabRef.current
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
  }, [props.activeId])
  const workspaceName = props.workspace
    ? props.workspace.replace(/\\/g, "/").split("/").pop() || t("topbar.workspaceFallback")
    : null

  const breadcrumb = buildBreadcrumb(props.workspace, props.filePath)

  // Arrow keys move the roving tab stop across the strip (WAI-ARIA tabs).
  // Focus is moved imperatively first: the button identities survive the
  // activation re-render, so the newly focused tab keeps focus.
  const handleTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const ids = props.tabs.map(tab => tab.id)
    if (ids.length === 0) return
    const currentIndex = Math.max(0, ids.indexOf(props.activeId))
    const lastIndex = ids.length - 1
    let nextIndex: number
    switch (event.key) {
      case "ArrowLeft": nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1; break
      case "ArrowRight": nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1; break
      case "Home": nextIndex = 0; break
      case "End": nextIndex = lastIndex; break
      default: return
    }
    event.preventDefault()
    const nextId = ids[nextIndex]
    if (nextId === undefined) return
    const buttons = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
    buttons[nextIndex]?.focus()
    props.onFocusTab(nextId)
  }

  return (
    <header className="topbar" data-tauri-drag-region="">
      {!props.sidebarOpen && props.onToggleSidebar ? (
        <div className="topbar-sidebar-toggle-wrapper">
          <button
            type="button"
            className="topbar-sidebar-toggle"
            onClick={props.onToggleSidebar}
            aria-label={t("topbar.aria.showSidebar")}
            title={t("topbar.title.showSidebar", { shortcut: shortcutFor("sidebar") ?? "" })}
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <span className="topbar-sidebar-divider" aria-hidden="true" />
        </div>
      ) : null}
      <div className="topbar-tabs-wrap" data-tauri-drag-region="">
        <div
          className="topbar-tabs"
          data-tauri-drag-region=""
          onKeyDown={handleTabsKeyDown}
        >
          {/* The close control must stay a sibling of the tab button, but
              WAI-ARIA 1.2 forbids `role="button"` children inside a tablist.
              The tablist therefore lives in an empty, layout-free owner and
              claims the tab buttons through `aria-owns` (same widget, no
              banned direct children). */}
          <div
            className="topbar-tablist-owner"
            role="tablist"
            aria-label={t("topbar.aria.tabs")}
            aria-owns={props.tabs.map(tab => `omd-tab-${tab.id}`).join(" ") || undefined}
          />
          {props.tabs.map(tab => {
            const isActive = tab.id === props.activeId
            const isDirty = props.dirtyIds.includes(tab.id)
            const hasConflict = props.conflictIds.includes(tab.id)
            const path = sessionPath(tab)
            return (
              // The close control is a sibling, never a child: interactive
              // content may not nest inside another button (WCAG 4.1.2).
              <div key={tab.id} className={isActive ? "tab-slot is-active" : "tab-slot"}>
                <button
                  type="button"
                  ref={isActive ? activeTabRef : undefined}
                  id={`omd-tab-${tab.id}`}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={isActive ? "tab is-active" : "tab"}
                  onClick={() => props.onFocusTab(tab.id)}
                  title={path ?? t("topbar.title.untitled")}
                >
                  <FileText size={13} className="tab-icon" aria-hidden="true" />
                  <span className={isActive ? "tab-title topbar-file" : "tab-title"}>
                    {sessionLabel(tab)}
                  </span>
                  {isDirty ? (
                    <span
                      className="tab-dirty"
                      aria-label={isActive ? t("topbar.aria.unsaved") : undefined}
                    >
                      •
                    </span>
                  ) : null}
                  {hasConflict ? (
                    <span className="tab-conflict" aria-label={t("topbar.aria.conflict")}>
                      !
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={t("topbar.aria.closeTab")}
                  onClick={() => props.onCloseTab(tab.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
        {/* Kept outside the scrollable strip so it stays reachable when the
            tabs overflow and the strip is scrolled. */}
        <button
          type="button"
          className="tab-new"
          aria-label={t("topbar.aria.newTab")}
          title={t("topbar.title.newTab")}
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
            aria-label={t("topbar.aria.preferences")}
            title={t("topbar.title.preferences", { shortcut: shortcutFor("preferences") ?? "" })}
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
  // relativeToDir yields forward-slash segments only on Windows; a POSIX file
  // name may contain a literal backslash, which must not become a segment.
  if (workspace && pathWithinDir(filePath, workspace)) {
    return relativeToDir(filePath, workspace).split("/")
  }
  return [baseName(filePath)]
}
