import { useEffect, useState, type KeyboardEvent } from "react"
import {
  EXPORT_HEADING_BREAKS,
  EXPORT_MARGIN_MAX_MM,
  EXPORT_MARGIN_MIN_MM,
  EXPORT_ORIENTATIONS,
  EXPORT_PAPERS,
  EXPORT_SCALE_OPTIONS,
  EXPORT_WIDTH_PRESETS,
  type ExportScale,
  type UserSettings,
} from "./settings"
import { useT } from "./i18n"

interface ExportSettingsSectionProps {
  settings: UserSettings
  onUpdate: (partial: Partial<UserSettings>) => void
}

const MARGIN_FIELDS = [
  ["exportMarginTopMm", "setting-margin-top", "settings.label.marginTop"],
  ["exportMarginRightMm", "setting-margin-right", "settings.label.marginRight"],
  ["exportMarginBottomMm", "setting-margin-bottom", "settings.label.marginBottom"],
  ["exportMarginLeftMm", "setting-margin-left", "settings.label.marginLeft"],
] as const

interface MarginNumberInputProps {
  id: string
  value: number
  onCommit: (mm: number) => void
}

/**
 * Buffers numeric text while typing so clearing to `""`, typing `"12."`, or
 * entering a multi-digit number does not snap back to `0` on every keystroke.
 */
function MarginNumberInput({ id, value, onCommit }: MarginNumberInputProps) {
  const [draft, setDraft] = useState(() => String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commitDraft = () => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (trimmed === "" || !Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.max(
      EXPORT_MARGIN_MIN_MM,
      Math.min(EXPORT_MARGIN_MAX_MM, Math.round(parsed * 10) / 10),
    )
    setDraft(String(clamped))
    if (clamped !== value) {
      onCommit(clamped)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitDraft()
    }
  }

  return (
    <input
      id={id}
      type="number"
      min={EXPORT_MARGIN_MIN_MM}
      max={EXPORT_MARGIN_MAX_MM}
      step={0.1}
      className="settings-input settings-input-number"
      value={draft}
      onChange={event => {
        const raw = event.target.value
        setDraft(raw)
        if (raw.trim() === "" || /[.-]$/.test(raw)) return
        const parsed = Number(raw)
        if (
          Number.isFinite(parsed)
          && parsed >= EXPORT_MARGIN_MIN_MM
          && parsed <= EXPORT_MARGIN_MAX_MM
        ) {
          onCommit(parsed)
        }
      }}
      onBlur={commitDraft}
      onKeyDown={handleKeyDown}
    />
  )
}

export function ExportSettingsSection({ settings, onUpdate }: ExportSettingsSectionProps) {
  const t = useT()

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.section.export")}</h3>

      <h4 className="settings-subheading">{t("settings.export.group.image")}</h4>
      <div className="settings-row">
        <label htmlFor="setting-export-width" className="settings-label">
          {t("settings.label.exportWidth")}
        </label>
        <select
          id="setting-export-width"
          className="settings-select"
          value={settings.exportWidth}
          onChange={e => onUpdate({ exportWidth: Number(e.target.value) })}
        >
          {EXPORT_WIDTH_PRESETS.map(preset => (
            <option key={preset.value} value={preset.value}>
              {t(preset.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="setting-export-scale" className="settings-label">
          {t("settings.label.exportScale")}
        </label>
        <select
          id="setting-export-scale"
          className="settings-select"
          value={settings.exportScale}
          onChange={e => onUpdate({ exportScale: Number(e.target.value) as ExportScale })}
        >
          {EXPORT_SCALE_OPTIONS.map(scale => (
            <option key={scale} value={scale}>
              {t(`settings.export.scale.${scale}`)}
            </option>
          ))}
        </select>
      </div>

      <p className="settings-note">
        {t("settings.export.pixelWidth", { width: settings.exportWidth * settings.exportScale })}
      </p>

      <h4 className="settings-subheading">{t("settings.export.group.pdf")}</h4>

      <div className="settings-row">
        <label htmlFor="setting-export-paper" className="settings-label">
          {t("settings.label.exportPaper")}
        </label>
        <select
          id="setting-export-paper"
          className="settings-select"
          value={settings.exportPaper}
          onChange={e => onUpdate({ exportPaper: e.target.value as UserSettings["exportPaper"] })}
        >
          {EXPORT_PAPERS.map(paper => (
            <option key={paper} value={paper}>
              {t(`settings.export.paper.${paper}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="setting-export-orientation" className="settings-label">
          {t("settings.label.exportOrientation")}
        </label>
        <select
          id="setting-export-orientation"
          className="settings-select"
          value={settings.exportOrientation}
          onChange={e => onUpdate({
            exportOrientation: e.target.value as UserSettings["exportOrientation"],
          })}
        >
          {EXPORT_ORIENTATIONS.map(orientation => (
            <option key={orientation} value={orientation}>
              {t(`settings.export.orientation.${orientation}`)}
            </option>
          ))}
        </select>
      </div>

      {MARGIN_FIELDS.map(([key, id, label]) => (
        <div className="settings-row" key={key}>
          <label htmlFor={id} className="settings-label">{t(label)}</label>
          <div className="settings-field-group">
            <MarginNumberInput
              id={id}
              value={settings[key]}
              onCommit={mm => onUpdate({ [key]: mm })}
            />
            <span className="settings-unit">{t("settings.unit.mm")}</span>
          </div>
        </div>
      ))}

      <div className="settings-row">
        <label htmlFor="setting-export-heading-break" className="settings-label">
          {t("settings.label.exportHeadingBreak")}
        </label>
        <select
          id="setting-export-heading-break"
          className="settings-select"
          value={settings.exportHeadingPageBreak}
          onChange={e => onUpdate({
            exportHeadingPageBreak: e.target.value as UserSettings["exportHeadingPageBreak"],
          })}
        >
          {EXPORT_HEADING_BREAKS.map(mode => (
            <option key={mode} value={mode}>
              {t(`settings.export.headingBreak.${mode}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="setting-export-header-footer" className="settings-label">
          {t("settings.label.exportHeaderFooter")}
        </label>
        <input
          id="setting-export-header-footer"
          type="checkbox"
          className="settings-checkbox"
          checked={settings.exportHeaderFooter}
          onChange={e => onUpdate({ exportHeaderFooter: e.target.checked })}
        />
      </div>
      <p className="settings-note">{t("settings.export.headerFooterNote")}</p>
    </div>
  )
}
