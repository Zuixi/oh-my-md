import { useMemo, useState } from "react"
import { useT } from "./i18n"
import { relativeToDir } from "./workspace"
import { useListboxNavigation } from "./useListboxNavigation"

/** Files shown per query; keeps the rendered list bounded on huge folders. */
const MAX_RENDERED = 200

/**
 * ⌘P file-name quick open. Filtering matches the command palette rule
 * (case-insensitive substring) so the two overlays feel the same.
 */
export function QuickOpenModal(props: {
  files: readonly string[]
  folder: string | null
  truncated: boolean
  loading: boolean
  onChoose: (path: string) => void
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")

  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    const filtered = q === ""
      ? props.files
      : props.files.filter(path => path.toLowerCase().includes(q))
    const folder = props.folder
    return filtered.slice(0, MAX_RENDERED).map(path => ({
      path,
      display: folder ? relativeToDir(path, folder) : path,
    }))
  }, [props.files, props.folder, q])

  const { active, setActive, activeId, onKeyDown } = useListboxNavigation({
    count: matches.length,
    resetKey: q,
    onChoose: index => {
      const match = matches[index]
      if (match) props.onChoose(match.path)
    },
    onClose: props.onClose,
    itemId: index => `quick-open-option-${index}`,
  })

  const note = props.loading
    ? t("quickOpen.loading")
    : matches.length === 0
      ? t("quickOpen.empty")
      : props.truncated
        ? t("quickOpen.truncated")
        : ""

  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={event => event.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={t("quickOpen.placeholder")}
          placeholder={t("quickOpen.placeholder")}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul id="quick-open-list" role="listbox">
          {matches.map((match, index) => (
            <li key={match.path} role="presentation">
              <button
                type="button"
                id={`quick-open-option-${index}`}
                role="option"
                // Focus stays on the combobox input so Tab never walks the rows.
                tabIndex={-1}
                aria-selected={index === active}
                className={index === active ? "omd-quick-open-active" : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  props.onChoose(match.path)
                  props.onClose()
                }}
              >
                {match.display}
              </button>
            </li>
          ))}
        </ul>
        <p className="omd-quick-open-note" role="status">{note}</p>
      </div>
    </div>
  )
}
