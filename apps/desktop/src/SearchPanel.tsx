import { useMemo, useRef, useState } from "react"
import { ChevronRight, FileText, FolderOpen, Search, X } from "lucide-react"
import { MAX_SEARCH_HITS } from "./constants"
import { useT } from "./i18n"
import { groupSearchHits } from "./searchResults"

export interface SearchHit {
  path: string
  line: number
  text: string
  start: number
  end: number
}

/** Chrome/WebKit keyCode reported for keys that commit an IME composition. */
const IME_COMPOSING_KEYCODE = 229

export function SearchPanel(props: {
  folder?: string | null
  query: string
  hits: SearchHit[]
  truncated: boolean
  searching?: boolean
  caseSensitive: boolean
  onQuery: (query: string) => void
  onCaseSensitive: (value: boolean) => void
  onOpen: (hit: SearchHit) => void
  onClose: () => void
  onOpenFolder?: () => void
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(
    () => groupSearchHits(props.hits, props.folder ?? null),
    [props.hits, props.folder],
  )
  const hasFolder = props.folder !== null

  const toggleGroup = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

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
          title={t("search.aria.close")}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {!hasFolder ? (
        <div className="sidebar-empty-state">
          <FolderOpen size={24} className="sidebar-empty-icon" aria-hidden="true" />
          <p className="sidebar-empty">{t("search.empty.noFolder")}</p>
          {props.onOpenFolder ? (
            <button
              type="button"
              className="sidebar-empty-cta"
              onClick={props.onOpenFolder}
            >
              {t("filetree.openFolder")}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="search-input-wrapper">
            <div className="search-input-box">
              <input
                ref={inputRef}
                className="search-input"
                autoFocus
                value={props.query}
                onChange={event => props.onQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.keyCode === IME_COMPOSING_KEYCODE) {
                    return
                  }
                  if (event.key !== "Escape") return
                  event.preventDefault()
                  if (props.query !== "") props.onQuery("")
                  else props.onClose()
                }}
                placeholder={t("search.placeholder.find")}
                aria-label={t("search.placeholder.find")}
              />
              {props.query !== "" ? (
                <button
                  type="button"
                  className="search-input-btn"
                  onClick={() => {
                    props.onQuery("")
                    inputRef.current?.focus()
                  }}
                  aria-label={t("search.aria.clear")}
                  title={t("search.aria.clear")}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className={`search-input-btn${props.caseSensitive ? " is-active" : ""}`}
                onClick={() => props.onCaseSensitive(!props.caseSensitive)}
                aria-pressed={props.caseSensitive}
                aria-label={t("search.caseSensitive")}
                title={t("search.caseSensitive")}
              >
                Aa
              </button>
            </div>
          </div>
          {props.query !== "" && !props.searching && props.hits.length > 0 ? (
            <div className="search-summary">
              <span>{t("search.summary", { hits: props.hits.length, files: groups.length })}</span>
            </div>
          ) : null}
          {props.truncated ? (
            <p className="search-truncated-note">
              {t("search.truncated", { max: MAX_SEARCH_HITS })}
            </p>
          ) : null}
          <div className="search-results">
            {props.query === "" ? (
              <p className="sidebar-empty">{t("search.empty.prompt")}</p>
            ) : props.searching ? (
              <p className="sidebar-empty" role="status">{t("search.status.searching")}</p>
            ) : groups.length === 0 ? (
              <p className="sidebar-empty">{t("search.empty.noResults")}</p>
            ) : (
              groups.map(group => {
                const isOpen = !collapsed.has(group.path)
                return (
                  <div key={group.path} className="search-group">
                    <button
                      type="button"
                      className="search-group-header"
                      aria-expanded={isOpen}
                      onClick={() => toggleGroup(group.path)}
                      title={group.path}
                    >
                      <span className="filetree-chevron" aria-hidden="true">
                        <ChevronRight size={13} className={isOpen ? "is-open" : undefined} />
                      </span>
                      <FileText size={13} aria-hidden="true" />
                      <span className="search-group-name">{group.name}</span>
                      {group.relativeDir ? (
                        <span className="search-group-dir">{group.relativeDir}</span>
                      ) : null}
                      <span className="search-group-count">{group.hits.length}</span>
                    </button>
                    {isOpen ? group.hits.map(hit => (
                      <button
                        key={`${hit.path}:${hit.line}:${hit.start}`}
                        type="button"
                        className="search-hit"
                        onClick={() => props.onOpen(hit)}
                      >
                        <span className="search-hit-line">{hit.line}</span>
                        <span className="search-hit-text">
                          {hit.text.slice(0, hit.start)}
                          <mark className="search-hit-mark">{hit.text.slice(hit.start, hit.end)}</mark>
                          {hit.text.slice(hit.end)}
                        </span>
                      </button>
                    )) : null}
                  </div>
                )
              })
            )}
          </div>
        </>
      )}
    </div>
  )
}
