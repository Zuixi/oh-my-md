import { useEffect, useRef, type KeyboardEvent } from "react"

export function FindReplaceBar(props: {
  open: boolean
  query: string
  replacement: string
  caseSensitive: boolean
  replaceOpen: boolean
  matchCount: number
  activeIndex: number
  onQuery: (query: string) => void
  onReplacement: (value: string) => void
  onCaseSensitive: (value: boolean) => void
  onNext: () => void
  onPrev: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}) {
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) queryRef.current?.focus()
  }, [props.open, props.replaceOpen])

  if (!props.open) return null

  const status = props.matchCount === 0
    ? "0 matches"
    : `${props.activeIndex + 1} of ${props.matchCount}`

  function onBarKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (event.shiftKey) props.onPrev()
      else props.onNext()
      return
    }
    if ((event.key === "g" || event.key === "G") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (event.shiftKey) props.onPrev()
      else props.onNext()
    }
  }

  return (
    <div className="find-replace-bar" role="search" onKeyDown={onBarKeyDown}>
      <input
        ref={queryRef}
        aria-label="Find"
        value={props.query}
        onChange={event => props.onQuery(event.target.value)}
        placeholder="Find in document…"
      />
      {props.replaceOpen ? (
        <input
          aria-label="Replace"
          value={props.replacement}
          onChange={event => props.onReplacement(event.target.value)}
          placeholder="Replace…"
        />
      ) : null}
      <label className="find-replace-case">
        <input
          type="checkbox"
          checked={props.caseSensitive}
          onChange={event => props.onCaseSensitive(event.target.checked)}
        />
        Case
      </label>
      <button type="button" onClick={props.onPrev}>Previous</button>
      <button type="button" onClick={props.onNext}>Next</button>
      {props.replaceOpen ? (
        <>
          <button type="button" onClick={props.onReplace}>Replace</button>
          <button type="button" onClick={props.onReplaceAll}>Replace all</button>
        </>
      ) : null}
      <span className="find-replace-status">{status}</span>
      <button type="button" onClick={props.onClose} aria-label="Close find">Close</button>
    </div>
  )
}
