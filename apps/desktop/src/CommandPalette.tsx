import { useState } from "react"
import { filterCommands, type AppCommand } from "./commands"
import { Dialog } from "./Dialog"
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
  // Mounted only while open, so the dialog effect runs once per open. Initial
  // focus belongs to `Dialog` (the first focusable is the input); a React
  // `autoFocus` here would run during commit and race the opener capture.
  return (
    <Dialog
      isOpen={true}
      onClose={props.onClose}
      backdropClassName="palette-backdrop"
      className="palette"
      ariaLabel={t("cmd.placeholder.run")}
    >
      <input
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
              // Focus stays on the combobox input so Tab never walks 200 rows.
              tabIndex={-1}
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
    </Dialog>
  )
}