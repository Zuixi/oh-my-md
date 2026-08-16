import { useEffect, useRef } from "react"
import { X } from "lucide-react"
import {
  DEFAULT_SETTINGS,
  FONT_FAMILY_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  sanitizeSettings,
  type AppTheme,
  type DefaultEditorMode,
  type TabSize,
  type UserSettings,
} from "./settings"

export interface SettingsModalProps {
  isOpen: boolean
  settings: UserSettings
  onSave: (settings: UserSettings) => void
  onClose: () => void
}

export function SettingsModal(props: SettingsModalProps) {
  const { isOpen, settings, onSave, onClose } = props
  const modalRef = useRef<HTMLDivElement>(null)

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
        aria-label="Preferences"
        onClick={e => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2 className="settings-title">Preferences</h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          {/* General Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">Appearance</h3>
            <div className="settings-row">
              <label htmlFor="setting-theme" className="settings-label">
                Theme
              </label>
              <select
                id="setting-theme"
                className="settings-select"
                value={settings.theme}
                onChange={e => update({ theme: e.target.value as AppTheme })}
              >
                <option value="system">Follow System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>

          {/* Editor Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">Editor</h3>

            <div className="settings-row">
              <label htmlFor="setting-font-size" className="settings-label">
                Font Size
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
                <span className="settings-unit">px</span>
              </div>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-font-family" className="settings-label">
                Font Family
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
                    {preset.label}
                  </option>
                ))}
                {!FONT_FAMILY_PRESETS.some(p => p.value === settings.fontFamily) ? (
                  <option value="custom">Custom</option>
                ) : null}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-line-height" className="settings-label">
                Line Height
              </label>
              <select
                id="setting-line-height"
                className="settings-select"
                value={settings.lineHeight}
                onChange={e => update({ lineHeight: Number(e.target.value) })}
              >
                {LINE_HEIGHT_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-tab-size" className="settings-label">
                Tab Size
              </label>
              <select
                id="setting-tab-size"
                className="settings-select"
                value={settings.tabSize}
                onChange={e => update({ tabSize: Number(e.target.value) as TabSize })}
              >
                <option value={2}>2 spaces</option>
                <option value={4}>4 spaces</option>
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-default-mode" className="settings-label">
                Default Mode
              </label>
              <select
                id="setting-default-mode"
                className="settings-select"
                value={settings.defaultMode}
                onChange={e => update({ defaultMode: e.target.value as DefaultEditorMode })}
              >
                <option value="live">Live Preview</option>
                <option value="source">Source Mode</option>
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="setting-spellcheck" className="settings-label">
                Spellcheck
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
        </div>

        <div className="settings-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={() => onSave(DEFAULT_SETTINGS)}
          >
            Reset to Defaults
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
