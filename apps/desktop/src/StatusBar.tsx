export function StatusBar(props: {
  path: string
  dirty: boolean
  words: number
  cursor: string
  mode: string
}) {
  return (
    <div className="statusbar">
      <span>{props.path}{props.dirty ? " •" : ""}</span>
      <span>{props.words} words</span>
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}
