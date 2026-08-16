import { X, Search } from "lucide-react"
import { MAX_SEARCH_HITS } from "./constants"

export interface SearchHit {
  path: string
  line: number
  text: string
  start: number
  end: number
}

export function SearchPanel(props: {
  query: string
  hits: SearchHit[]
  truncated: boolean
  caseSensitive: boolean
  onQuery: (query: string) => void
  onCaseSensitive: (value: boolean) => void
  onOpen: (hit: SearchHit) => void
  onClose: () => void
}) {
  return (
    <div className="search-panel">
      <div className="sidebar-title">
        <div className="sidebar-title-left">
          <Search size={14} className="filetree-search-icon" aria-hidden="true" />
          <span className="sidebar-title-text">Search</span>
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={props.onClose}
          aria-label="Close search"
        >
          <X size={14} />
        </button>
      </div>
      <div className="search-input-wrapper">
        <input
          autoFocus
          value={props.query}
          onChange={event => props.onQuery(event.target.value)}
          placeholder="Find in folder…"
        />
      </div>
      <label className="find-replace-case">
        <input
          type="checkbox"
          checked={props.caseSensitive}
          onChange={event => props.onCaseSensitive(event.target.checked)}
        />
        Case
      </label>
      {props.truncated ? (
        <p className="search-truncated-note">Results limited to {MAX_SEARCH_HITS}</p>
      ) : null}
      {props.hits.map(hit => (
        <button
          key={`${hit.path}:${hit.line}`}
          type="button"
          className="search-hit"
          onClick={() => props.onOpen(hit)}
        >
          <span className="search-hit-location">
            {hit.path.split("/").pop()}:{hit.line}
          </span>{" "}
          {hit.text.slice(0, hit.start)}
          <mark className="search-hit-mark">{hit.text.slice(hit.start, hit.end)}</mark>
          {hit.text.slice(hit.end)}
        </button>
      ))}
    </div>
  )
}
