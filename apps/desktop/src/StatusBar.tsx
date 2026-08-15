export type SaveStatus = "idle" | "saving" | "save failed" | "conflict"

export function StatusBar(props: {
  words: number
  chars: number
  cursor: string
  mode: string
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
}) {
  return (
    <div className="statusbar">
      {props.normalizationReviewRequired
        ? <span className="statusbar-review">Normalization review required</span>
        : null}
      {props.saveStatus !== "idle"
        ? <span className="statusbar-save-status">{props.saveStatus}</span>
        : null}
      <span>{props.words} words · {props.chars} chars</span>
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}
