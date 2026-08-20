import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  sanitizeSettings,
  type AppTheme,
  type DefaultEditorMode,
  type TabSize,
  type UserSettings,
} from "./settings"
import { localeOptions, useT, type StoredLocale } from "./i18n"
import { FontFamilyPicker } from "./FontFamilyPicker"

export interface SettingsModalProps {
  isOpen: boolean
  settings: UserSettings
  onSave: (settings: UserSettings) => void
  onClose: () => void
  listSystemFonts?: () => Promise<string[] | null>
}

export function SettingsModal(props: SettingsModalProps) {
  const { isOpen, settings, onSave, onClose, listSystemFonts } = props
  const modalRef = useRef<HTMLDivElement>(null)
  const t = useT()
  // System font families: fetched once on the first picker open, then cached
  // (undefined = never requested, null = enumeration failed, array = loaded).
  // The picker stays mounted while the modal is open, so open/close reuses it.
  const fontFamiliesCacheRef = useRef<string[] | null | undefined>(undefined)
  const [fontFamilies, setFontFamilies] = useState<string[] | null>([])
  const [fontFamiliesLoading, setFontFamiliesLoading] = useState(false)

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

  const handleFontPickerOpen = () => {
    if (fontFamiliesCacheRef.current !== undefined) return
    if (!listSystemFonts) {
      fontFamiliesCacheRef.current = []
      return
    }
    setFontFamiliesLoading(true)
    void listSystemFonts()
      .catch(() => null)
      .then(families => {
        const result = families ?? null
        fontFamiliesCacheRef.current = result
        setFontFamilies(result)
        setFontFamiliesLoading(false)
      })
  }

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
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
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
              <FontFamilyPicker
                value={settings.fontFamily}
                families={fontFamilies}
                loading={fontFamiliesLoading}
                onOpen={handleFontPickerOpen}
                onSelect={cssValue => update({ fontFamily: cssValue })}
              />
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
                {LINE_HEIGHT_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>
                    {t(preset.labelKey)}
                  </option>
                ))}
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