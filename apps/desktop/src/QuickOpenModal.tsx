import { useEffect, useMemo, useState } from "react"
import { useT } from "./i18n"

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
  const [active, setActive] = useState(0)

  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    const filtered = q === ""
      ? props.files
      : props.files.filter(path => path.toLowerCase().includes(q))
    const folder = props.folder
    return filtered.slice(0, MAX_RENDERED).map(path => ({
      path,
      display: folder && path.startsWith(`${folder}/`)
        ? path.slice(folder.length + 1)
        : path,
    }))
  }, [props.files, props.folder, q])

  useEffect(() => { setActive(0) }, [q])

  function choose(index: number): boolean {
    const match = matches[index]
    if (!match) return false
    props.onChoose(match.path)
    return true
  }

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
          aria-label={t("quickOpen.placeholder")}
          placeholder={t("quickOpen.placeholder")}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault()
              props.onClose()
              return
            }
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setActive(value => Math.min(value + 1, matches.length - 1))
              return
            }
            if (event.key === "ArrowUp") {
              event.preventDefault()
              setActive(value => Math.max(value - 1, 0))
              return
            }
            if (event.key === "Enter") {
              event.preventDefault()
              if (choose(active)) props.onClose()
            }
          }}
        />
        <ul>
          {matches.map((match, index) => (
            <li key={match.path}>
              <button
                type="button"
                className={index === active ? "omd-quick-open-active" : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  if (choose(index)) props.onClose()
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
