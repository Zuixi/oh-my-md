import { useState } from "react"
import { filterCommands, type AppCommand } from "./commands"
import { useT } from "./i18n"
import { useListboxNavigation } from "./useListboxNavigation"

export function CommandPalette(props: {
  commands: AppCommand[]
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const matches = filterCommands(props.commands, query)
  const { active, setActive, activeId, onKeyDown } = useListboxNavigation({
    count: matches.length,
    resetKey: query,
    onChoose: index => matches[index]?.run(),
    onClose: props.onClose,
    itemId: index => `command-option-${index}`,
  })
  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={event => event.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          placeholder={t("cmd.placeholder.run")}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul id="command-palette-list" role="listbox">
          {matches.map((command, index) => (
            <li key={command.id} role="presentation">
              <button
                type="button"
                id={`command-option-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? "omd-quick-open-active" : undefined}
                onMouseEnter={() => setActive(index)}
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