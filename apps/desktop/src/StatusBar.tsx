export type SaveStatus = "idle" | "saving" | "save failed" | "conflict"

export function StatusBar(props: {
  path: string
  dirty: boolean
  words: number
  cursor: string
  mode: string
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
}) {
  return (
    <div className="statusbar">
      <span>{`${props.path}${props.dirty ? " •" : ""}`}</span>
      {props.normalizationReviewRequired
        ? <span className="statusbar-review">Normalization review required</span>
        : null}
      {props.saveStatus !== "idle"
        ? <span className="statusbar-save-status">{props.saveStatus}</span>
        : null}
      <span>{props.words} words</span>
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}
