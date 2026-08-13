export function StatusBar(props: {
  path: string
  dirty: boolean
  words: number
  cursor: string
  mode: string
  normalizationReviewRequired?: boolean
}) {
  return (
    <div className="statusbar">
      <span>{`${props.path}${props.dirty ? " •" : ""}`}</span>
      {props.normalizationReviewRequired
        ? <span className="statusbar-review">Normalization review required</span>
        : null}
      <span>{props.words} words</span>
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}
