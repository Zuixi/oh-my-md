import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { FONT_FAMILY_PRESETS, cssFamily, familyFromCssValue } from "./settings"
import { useT } from "./i18n"

/** Rows shown per query; keeps the popover light on font-heavy machines. */
const MAX_RENDERED = 200

interface PickerRow {
  readonly key: string
  readonly label: string
  readonly cssValue: string
  /** Live-preview font-family style; presets are stacks and stay unstyled. */
  readonly preview: string | null
}

export interface FontFamilyPickerProps {
  value: string
  /** null = enumeration failed; empty = service absent / not loaded yet. */
  families: string[] | null
  loading: boolean
  onSelect: (cssValue: string) => void
  /** Fired on every popover open; the host lazy-loads once and caches. */
  onOpen: () => void
}

/**
 * Typora-style Font Family control: a trigger button plus a popover with the
 * presets pinned above the system font list. Presentational only — the host
 * (SettingsModal) owns loading and caching the family list.
 */
export function FontFamilyPicker(props: FontFamilyPickerProps) {
  const { value, families, loading, onSelect, onOpen } = props
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const q = query.trim().toLowerCase()
  const matchedFamilies = useMemo(() => {
    if (families === null) return []
    return q === "" ? families : families.filter(name => name.toLowerCase().includes(q))
  }, [families, q])
  const visibleFamilies = useMemo(() => matchedFamilies.slice(0, MAX_RENDERED), [matchedFamilies])
  const truncated = matchedFamilies.length > visibleFamilies.length

  const rows = useMemo<PickerRow[]>(
    () => [
      ...FONT_FAMILY_PRESETS.map(preset => ({
        key: `preset:${preset.value}`,
        label: t(preset.labelKey),
        cssValue: preset.value,
        preview: null,
      })),
      ...visibleFamilies.map(name => {
        const cssValue = cssFamily(name)
        return { key: `family:${name}`, label: name, cssValue, preview: cssValue }
      }),
    ],
    [t, visibleFamilies],
  )

  useEffect(() => { setActive(0) }, [q])

  // Keep the keyboard-active row revealed inside the scroll area. happy-dom
  // lacks scrollIntoView, so guard like TopBar's tab-reveal effect.
  useEffect(() => {
    const el = activeRowRef.current
    if (open && el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" })
    }
  }, [active, open])

  // Close on outside press while open (AppMenu idiom: listener scoped to the
  // open state, membership checked via ref so the handler stays stable).
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [open])

  const presetMatch = FONT_FAMILY_PRESETS.find(preset => preset.value === value)
  const triggerLabel = presetMatch
    ? t(presetMatch.labelKey)
    : familyFromCssValue(value, families ?? []) ?? t("settings.font.custom")

  const showDivider = !loading && visibleFamilies.length > 0

  const note = loading
    ? t("quickOpen.loading")
    : families === null
      ? t("settings.font.loadFailed")
      : truncated
        ? t("settings.font.truncated", {
            shown: visibleFamilies.length,
            total: matchedFamilies.length,
          })
        : ""

  function close(): void {
    setOpen(false)
  }

  function commit(index: number): boolean {
    const row = rows[index]
    if (!row) return false
    onSelect(row.cssValue)
    return true
  }

  return (
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        id="setting-font-family"
        className="settings-select font-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close()
            return
          }
          setQuery("")
          setActive(0)
          setOpen(true)
          onOpen()
        }}
      >
        {triggerLabel}
      </button>
      {open ? (
        <div className="font-picker-popover">
          <input
            autoFocus
            className="font-picker-search"
            aria-label={t("settings.font.searchPlaceholder")}
            placeholder={t("settings.font.searchPlaceholder")}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                // Close only the popover; stopPropagation keeps the modal open.
                event.preventDefault()
                event.stopPropagation()
                close()
                return
              }
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setActive(current => Math.min(current + 1, rows.length - 1))
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                setActive(current => Math.max(current - 1, 0))
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                if (commit(active)) close()
              }
            }}
          />
          <div className="font-picker-list" role="listbox" aria-label={t("settings.label.fontFamily")}>
            {rows.map((row, index) => (
              <Fragment key={row.key}>
                {showDivider && index === FONT_FAMILY_PRESETS.length ? (
                  <div className="font-picker-divider" role="presentation">
                    {t("settings.font.systemFonts")}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={row.cssValue === value}
                  className={
                    index === active ? "font-picker-row font-picker-row-active" : "font-picker-row"
                  }
                  style={row.preview ? { fontFamily: row.preview } : undefined}
                  ref={index === active ? activeRowRef : undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    if (commit(index)) close()
                  }}
                >
                  {row.label}
                </button>
              </Fragment>
            ))}
          </div>
          <p className="font-picker-note" role="status">{note}</p>
        </div>
      ) : null}
    </div>
  )
}
