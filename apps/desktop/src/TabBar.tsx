import { sessionLabel, type EditorSession } from "./session"

export function TabBar(props: {
  tabs: EditorSession[]
  activeId: number
  dirtyIds: number[]
  onFocus: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}) {
  return (
    <div className="tabbar">
      {props.tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          className={tab.id === props.activeId ? "tab is-active" : "tab"}
          onClick={() => props.onFocus(tab.id)}
        >
          {sessionLabel(tab)}
          {props.dirtyIds.includes(tab.id) ? <span className="tab-dirty">•</span> : null}
          <span
            className="tab-close"
            onClick={event => {
              event.stopPropagation()
              props.onClose(tab.id)
            }}
          >
            ×
          </span>
        </button>
      ))}
      <button type="button" className="tab-new" onClick={props.onNew}>+</button>
    </div>
  )
}
