import { Search, X } from "lucide-react"

export interface SearchHit {
  path: string
  line: number
  text: string
}

export function SearchPanel(props: {
  query: string
  hits: SearchHit[]
  onQuery: (query: string) => void
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
      {props.hits.map(hit => (
        <button
          key={`${hit.path}:${hit.line}`}
          type="button"
          className="search-hit"
          onClick={() => props.onOpen(hit)}
        >
          {hit.path.split("/").pop()}:{hit.line} {hit.text}
        </button>
      ))}
    </div>
  )
}
