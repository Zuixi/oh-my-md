import { ChevronRight, Settings } from "lucide-react"
import { useT } from "./i18n"
import { useEditorStatus, type EditorStatusStore } from "./editorStatusStore"
import { shortcutFor } from "./shortcuts"
import { baseName, pathWithinDir, relativeToDir } from "./workspace"

export type SaveStatus = "idle" | "saving" | "save failed" | "conflict"

/** `idle` renders nothing (the caller filters it), so it has no label key. */
type VisibleSaveStatus = Exclude<SaveStatus, "idle">

function saveStatusDisplay(status: VisibleSaveStatus, t: (key: string) => string): string {
  switch (status) {
    case "saving": return t("statusbar.status.saving")
    case "save failed": return t("statusbar.status.saveFailed")
    case "conflict": return t("statusbar.status.conflict")
  }
}

function buildBreadcrumb(workspace: string | null | undefined, filePath: string | null | undefined): string[] {
  if (!filePath) return []
  // relativeToDir yields forward-slash segments only on Windows; a POSIX file
  // name may contain a literal backslash, which must not become a segment.
  if (workspace && pathWithinDir(filePath, workspace)) {
    return relativeToDir(filePath, workspace).split("/")
  }
  return [baseName(filePath)]
}

export function StatusBar(props: {
  statusStore: EditorStatusStore
  /** null = stats are suppressed (safe mode) until onRequestStats runs. */
  stats: { words: number; chars: number } | null
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
  onRequestStats?: () => void
  workspace?: string | null
  filePath?: string | null
  onOpenSettings?: () => void
  onRevealPath?: (path: string) => void
}) {
  const t = useT()
  const { cursor, mode } = useEditorStatus(props.statusStore)
  const workspaceName = props.workspace
    ? props.workspace.replace(/\\/g, "/").split("/").pop() || t("topbar.workspaceFallback")
    : null
  const breadcrumb = buildBreadcrumb(props.workspace, props.filePath)
  const showBreadcrumb = breadcrumb.length > 0 && Boolean(workspaceName)

  const breadcrumbContent = showBreadcrumb ? (
    <>
      <span className="statusbar-workspace">{workspaceName}</span>
      {breadcrumb.map((segment, i) => (
        <span key={i} className="statusbar-segment">
          <ChevronRight size={11} className="statusbar-separator" aria-hidden="true" />
          <span className="statusbar-dir">{segment}</span>
        </span>
      ))}
    </>
  ) : null

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {props.onOpenSettings ? (
          <button
            type="button"
            className="statusbar-action-btn"
            onClick={props.onOpenSettings}
            aria-label={t("topbar.aria.preferences")}
            title={t("topbar.title.preferences", { shortcut: shortcutFor("preferences") ?? "" })}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
        ) : null}
        {props.onOpenSettings && showBreadcrumb ? (
          <span className="statusbar-divider" aria-hidden="true" />
        ) : null}
        {showBreadcrumb ? (
          props.onRevealPath && props.filePath ? (
            <button
              type="button"
              className="statusbar-breadcrumb statusbar-breadcrumb-interactive"
              title={props.filePath}
              onClick={() => props.onRevealPath?.(props.filePath!)}
            >
              {breadcrumbContent}
            </button>
          ) : (
            <div className="statusbar-breadcrumb" title={props.filePath ?? undefined}>
              {breadcrumbContent}
            </div>
          )
        ) : null}
      </div>

      <div className="statusbar-right">
        {props.normalizationReviewRequired
          ? <span className="statusbar-review">{t("statusbar.reviewRequired")}</span>
          : null}
        {props.saveStatus !== "idle"
          ? <span className="statusbar-save-status">{saveStatusDisplay(props.saveStatus, t)}</span>
          : null}
        {props.stats
          ? <span>{t("statusbar.wordsChars", { words: props.stats.words, chars: props.stats.chars })}</span>
          : props.onRequestStats
            ? <button type="button" className="statusbar-count" onClick={props.onRequestStats}>
                {t("statusbar.countWords")}
              </button>
            : null}
        <span>{cursor}</span>
        <span>{mode}</span>
      </div>
    </div>
  )
}
