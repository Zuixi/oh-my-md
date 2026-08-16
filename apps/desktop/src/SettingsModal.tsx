import { useEffect, useRef } from "react"
import { X } from "lucide-react"
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppTheme,
  type DefaultEditorMode,
  type TabSize,
  type UserSettings,
} from "./settings"
import { localeOptions, useT, type StoredLocale } from "./i18n"

export interface SettingsModalProps {
  isOpen: boolean
  settings: UserSettings
  onSave: (settings: UserSettings) => void
  onClose: () => void
}

const FONT_FAMILY_PRESETS: { labelKey: string; value: string }[] = [
  { labelKey: "settings.font.systemDefault", value: "system-ui, -apple-system, sans-serif" },
  { labelKey: "settings.font.monospace", value: "ui-monospace, Menlo, Monaco, Consolas, monospace" },
  { labelKey: "settings.font.serif", value: "Georgia, 'Times New Roman', serif" },
]

export function SettingsModal(props: SettingsModalProps) {
  const { isOpen, settings, onSave, onClose } = props
  const modalRef = useRef<HTMLDivElement>(null)
  const t = useT()

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const update = (partial: Partial<UserSettings>) => {
    onSave(sanitizeSettings({ ...settings, ...partial }))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-label={t("settings.aria.dialog")}
        onClick={e => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2 className="settings-title">{t("settings.title")}</h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label={t("settings.aria.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          {/* General Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">{t("settings.section.appearance")}</h3>
            <div className="settings-row">
              <label htmlFor="setting-theme" className="settings-label">
                {t("settings.label.theme")}
              </label>
              <select
                id="setting-theme"
                className="settings-select"
                value={settings.theme}
                onChange={e => update({ theme: e.target.value as AppTheme })}
              >
                <option value="system">{t("settings.theme.system")}</option>
                <option value="light">{t("settings.theme.light")}</option>
                <option value="dark">{t("settings.theme.dark")}</option>
              </select>
            </div>
          </div>

          {/* Editor Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">{t("settings.section.editor")}</h3>

            <div className="settings-row">
              <label htmlFor="setting-font-size" className="settings-label">
                {t("settings.label.fontSize")}
              </label>
              <div className="settings-field-group">
                <input
                  id="setting-font-size"
                  type="number"
                  min={12}
                  max={32}
                  className="settings-input settings-input-number"
                  value={settings.fontSize}
                  onChange={e => update({ fontSize: Number(e.target.value) })}
                />
                <span className="settings-unit">{t("settings.unit.px")}</span>
              </div>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-font-family" className="settings-label">
                {t("settings.label.fontFamily")}
              </label>
              <select
                id="setting-font-family"
                className="settings-select"
                value={
                  FONT_FAMILY_PRESETS.some(p => p.value === settings.fontFamily)
                    ? settings.fontFamily
                    : "custom"
                }
                onChange={e => {
                  if (e.target.value !== "custom") {
                    update({ fontFamily: e.target.value })
                  }
                }}
              >
                {FONT_FAMILY_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>
                    {t(preset.labelKey)}
                  </option>
                ))}
                {!FONT_FAMILY_PRESETS.some(p => p.value === settings.fontFamily) ? (
                  <option value="custom">{t("settings.font.custom")}</option>
                ) : null}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-line-height" className="settings-label">
                {t("settings.label.lineHeight")}
              </label>
              <select
                id="setting-line-height"
                className="settings-select"
                value={settings.lineHeight}
                onChange={e => update({ lineHeight: Number(e.target.value) })}
              >
                <option value={1.4}>{t("settings.lineHeight.compact")}</option>
                <option value={1.6}>{t("settings.lineHeight.default")}</option>
                <option value={1.8}>{t("settings.lineHeight.spacious")}</option>
                <option value={2.0}>{t("settings.lineHeight.double")}</option>
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-tab-size" className="settings-label">
                {t("settings.label.tabSize")}
              </label>
              <select
                id="setting-tab-size"
                className="settings-select"
                value={settings.tabSize}
                onChange={e => update({ tabSize: Number(e.target.value) as TabSize })}
              >
                <option value={2}>{t("settings.tabSize.twoSpaces")}</option>
                <option value={4}>{t("settings.tabSize.fourSpaces")}</option>
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-default-mode" className="settings-label">
                {t("settings.label.defaultMode")}
              </label>
              <select
                id="setting-default-mode"
                className="settings-select"
                value={settings.defaultMode}
                onChange={e => update({ defaultMode: e.target.value as DefaultEditorMode })}
              >
                <option value="live">{t("settings.mode.live")}</option>
                <option value="source">{t("settings.mode.source")}</option>
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-spellcheck" className="settings-label">
                {t("settings.label.spellcheck")}
              </label>
              <input
                id="setting-spellcheck"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.spellcheck}
                onChange={e => update({ spellcheck: e.target.checked })}
              />
            </div>
          </div>

          {/* Language Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">{t("settings.section.language")}</h3>
            <div className="settings-row">
              <label htmlFor="setting-locale" className="settings-label">
                {t("settings.section.language")}
              </label>
              <select
                id="setting-locale"
                className="settings-select"
                value={settings.locale}
                onChange={e => update({ locale: e.target.value as StoredLocale })}
              >
                {localeOptions.map(o => (
                  <option key={o.value} value={o.value}>
                    {t(o.key)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={() => onSave(DEFAULT_SETTINGS)}
          >
            {t("settings.button.reset")}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={onClose}
          >
            {t("settings.button.done")}
          </button>
        </div>
      </div>
    </div>
  )
}