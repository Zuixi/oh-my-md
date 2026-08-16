import { useT } from "./i18n"

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
  words: number
  chars: number
  cursor: string
  mode: string
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
}) {
  const t = useT()
  return (
    <div className="statusbar">
      {props.normalizationReviewRequired
        ? <span className="statusbar-review">{t("statusbar.reviewRequired")}</span>
        : null}
      {props.saveStatus !== "idle"
        ? <span className="statusbar-save-status">{saveStatusDisplay(props.saveStatus, t)}</span>
        : null}
      <span>{t("statusbar.wordsChars", { words: props.words, chars: props.chars })}</span>
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}