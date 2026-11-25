import type { KeyboardEvent, ReactNode } from "react"
import { Check } from "lucide-react"
import type { AppTheme } from "./settings"
import { useT } from "./i18n"

export interface SettingsRowProps {
  label: string
  htmlFor?: string
  labelId?: string
  note?: string
  control: ReactNode
}

/** Standard two-column settings row: label (+ optional muted note) on the left, control on the right. */
export function SettingsRow({ label, htmlFor, labelId, note, control }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className="settings-label">
            {label}
          </label>
        ) : (
          <span id={labelId} className="settings-label">
            {label}
          </span>
        )}
        {note ? <p className="settings-note">{note}</p> : null}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}

export interface SettingsSwitchProps {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** Toggle switch backed by a native checkbox so `<label htmlFor>` and keyboard Space work natively. */
export function SettingsSwitch({ id, checked, disabled, onChange }: SettingsSwitchProps) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="settings-switch"
      checked={checked}
      disabled={disabled}
      onChange={e => onChange(e.target.checked)}
    />
  )
}

export interface SegmentedOption<T extends string | number> {
  readonly value: T
  readonly label: string
}

export interface SettingsSegmentedProps<T extends string | number> {
  labelledBy: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
}

/** Compact radio-group segmented control for 2-3 mutually exclusive choices. */
export function SettingsSegmented<T extends string | number>(props: SettingsSegmentedProps<T>) {
  const { labelledBy, value, options, onChange } = props

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const delta = event.key === "ArrowRight" ? 1 : -1
    const nextIndex = (index + delta + options.length) % options.length
    onChange(options[nextIndex].value)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div className="settings-segmented" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={
              selected
                ? "settings-segmented-item settings-segmented-item-active"
                : "settings-segmented-item"
            }
            onClick={() => onChange(option.value)}
            onKeyDown={event => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const THEME_OPTIONS: ReadonlyArray<{
  readonly value: AppTheme
  readonly labelKey: "settings.theme.system" | "settings.theme.light" | "settings.theme.dark"
}> = [
  { value: "system", labelKey: "settings.theme.system" },
  { value: "light", labelKey: "settings.theme.light" },
  { value: "dark", labelKey: "settings.theme.dark" },
]

export interface SettingsThemePickerProps {
  labelledBy: string
  value: AppTheme
  onChange: (theme: AppTheme) => void
}

/** Three-card visual theme selector (Follow System / Light / Dark) with mini editor previews. */
export function SettingsThemePicker({ labelledBy, value, onChange }: SettingsThemePickerProps) {
  const t = useT()

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const delta = event.key === "ArrowRight" ? 1 : -1
    const nextIndex = (index + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length
    onChange(THEME_OPTIONS[nextIndex].value)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div className="settings-theme-grid" role="radiogroup" aria-labelledby={labelledBy}>
      {THEME_OPTIONS.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={
              selected
                ? "settings-theme-card settings-theme-card-active"
                : "settings-theme-card"
            }
            onClick={() => onChange(option.value)}
            onKeyDown={event => handleKeyDown(event, index)}
          >
            <span
              className={`settings-theme-preview settings-theme-preview-${option.value}`}
              aria-hidden="true"
            >
              {option.value === "system" ? (
                <>
                  <span className="settings-theme-half settings-theme-half-light">
                    <span className="settings-theme-bar" />
                    <span className="settings-theme-line settings-theme-line-title" />
                    <span className="settings-theme-line" />
                    <span className="settings-theme-line settings-theme-line-short" />
                  </span>
                  <span className="settings-theme-half settings-theme-half-dark">
                    <span className="settings-theme-bar" />
                    <span className="settings-theme-line settings-theme-line-title" />
                    <span className="settings-theme-line" />
                    <span className="settings-theme-line settings-theme-line-short" />
                  </span>
                </>
              ) : (
                <span className="settings-theme-canvas">
                  <span className="settings-theme-bar" />
                  <span className="settings-theme-line settings-theme-line-title" />
                  <span className="settings-theme-line" />
                  <span className="settings-theme-line settings-theme-line-short" />
                </span>
              )}
            </span>
            <span className="settings-theme-caption">
              <span className="settings-theme-label">{t(option.labelKey)}</span>
              {selected ? (
                <span className="settings-theme-check" aria-hidden="true">
                  <Check size={12} strokeWidth={2.5} />
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
