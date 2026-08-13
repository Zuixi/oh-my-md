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
        Search
        <button type="button" onClick={props.onClose}>×</button>
      </div>
      <input
        autoFocus
        value={props.query}
        onChange={event => props.onQuery(event.target.value)}
        placeholder="Find in folder…"
      />
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
