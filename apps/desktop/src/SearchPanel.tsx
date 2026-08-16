import { Search, X } from "lucide-react"
import { useT } from "./i18n"

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
  const t = useT()
  return (
    <div className="search-panel">
      <div className="sidebar-title">
        <div className="sidebar-title-left">
          <Search size={14} className="filetree-search-icon" aria-hidden="true" />
          <span className="sidebar-title-text">{t("search.title")}</span>
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={props.onClose}
          aria-label={t("search.aria.close")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="search-input-wrapper">
        <input
          autoFocus
          value={props.query}
          onChange={event => props.onQuery(event.target.value)}
          placeholder={t("search.placeholder.find")}
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