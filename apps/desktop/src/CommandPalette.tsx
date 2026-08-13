import { useState } from "react"
import { filterCommands, type AppCommand } from "./commands"

export function CommandPalette(props: {
  commands: AppCommand[]
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const matches = filterCommands(props.commands, query)
  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={event => event.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Run a command…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") props.onClose()
            if (event.key === "Enter" && matches[0]) {
              matches[0].run()
              props.onClose()
            }
          }}
        />
        <ul>
          {matches.map(command => (
            <li key={command.id}>
              <button
                type="button"
                onClick={() => {
                  command.run()
                  props.onClose()
                }}
              >
                {command.label}
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
