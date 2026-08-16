import { useEffect, useRef, type KeyboardEvent } from "react"
import { useT } from "./i18n"

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
  const t = useT()
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) queryRef.current?.focus()
  }, [props.open, props.replaceOpen])

  if (!props.open) return null

  const status = props.matchCount === 0
    ? t("find.status.zero")
    : t("find.status.count", { active: props.activeIndex + 1, total: props.matchCount })

  function onBarKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) props.onPrev()
      else props.onNext()
      return
    }
    if ((event.key === "g" || event.key === "G") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) props.onPrev()
      else props.onNext()
    }
  }

  return (
    <div className="find-replace-bar" role="search" onKeyDown={onBarKeyDown}>
      <input
        ref={queryRef}
        aria-label={t("find.aria.find")}
        value={props.query}
        onChange={event => props.onQuery(event.target.value)}
        placeholder={t("find.placeholder.find")}
      />
      {props.replaceOpen ? (
        <input
          aria-label={t("find.aria.replace")}
          value={props.replacement}
          onChange={event => props.onReplacement(event.target.value)}
          placeholder={t("find.placeholder.replace")}
        />
      ) : null}
      <label className="find-replace-case">
        <input
          type="checkbox"
          checked={props.caseSensitive}
          onChange={event => props.onCaseSensitive(event.target.checked)}
        />
        {t("find.label.case")}
      </label>
      <button type="button" onClick={props.onPrev}>{t("find.button.previous")}</button>
      <button type="button" onClick={props.onNext}>{t("find.button.next")}</button>
      {props.replaceOpen ? (
        <>
          <button type="button" onClick={props.onReplace}>{t("find.button.replace")}</button>
          <button type="button" onClick={props.onReplaceAll}>{t("find.button.replaceAll")}</button>
        </>
      ) : null}
      <span className="find-replace-status">{status}</span>
      <button type="button" onClick={props.onClose} aria-label={t("find.aria.close")}>{t("find.action.close")}</button>
    </div>
  )
}
