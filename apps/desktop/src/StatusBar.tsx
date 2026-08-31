import { useT } from "./i18n"
import { useEditorStatus, type EditorStatusStore } from "./editorStatusStore"

export type SaveStatus = "idle" | "saving" | "save failed" | "conflict"

function saveStatusDisplay(status: SaveStatus, t: (key: string) => string): string {
  switch (status) {
    case "idle": return t("statusbar.status.idle")
    case "saving": return t("statusbar.status.saving")
    case "save failed": return t("statusbar.status.saveFailed")
    case "conflict": return t("statusbar.status.conflict")
  }
}

export function StatusBar(props: {
  statusStore: EditorStatusStore
  /** null = stats are suppressed (safe mode) until onRequestStats runs. */
  stats: { words: number; chars: number } | null
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
  onRequestStats?: () => void
}) {
  const t = useT()
  const { cursor, mode } = useEditorStatus(props.statusStore)
  return (
    <div className="statusbar">
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
  )
}
