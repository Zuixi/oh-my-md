import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import {
  DEFAULT_SETTINGS,
  EXPORT_SCALE_OPTIONS,
  EXPORT_WIDTH_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  sanitizeSettings,
  type AppTheme,
  type DefaultEditorMode,
  type ExportScale,
  type TabSize,
  type UserSettings,
} from "./settings"
import { localeOptions, useT, type StoredLocale } from "./i18n"
import type { LogStateView } from "./logging"
import { ISSUES_URL, TROUBLESHOOTING_URL } from "./constants"
import { FontFamilyPicker } from "./FontFamilyPicker"

export interface SettingsModalProps {
  isOpen: boolean
  settings: UserSettings
  onSave: (settings: UserSettings) => void
  onClose: () => void
  listSystemFonts?: () => Promise<string[] | null>
  /** Resolved logging destination; `null` while it has not loaded yet. */
  logState?: LogStateView | null
  /** Opens an external URL (the troubleshooting guide / issue form). */
  openUrl?: (url: string) => void
  /** Restart to apply a logging preference that only takes effect at startup. */
  onRestartToApplyLogging?: () => void
}

/**
 * What the logging status row must say, given the checkbox and the state the
 * engine resolved at startup.
 *
 * The two can disagree for one session, because `install()` runs once: flipping
 * the toggle writes the setting but cannot attach or detach the plugin. Reporting
 * only the engine's answer made the panel tell a user who had just enabled
 * logging to "turn on Save diagnostic logs" — an instruction that contradicts
 * the checkbox directly above it.
 */
export type LoggingStatusKind = "off" | "levelOff" | "enabling" | "disabling" | "healthy" | "degraded"

/** The two statuses whose change is waiting for a restart. */
const PENDING_LOGGING_STATUSES: ReadonlySet<LoggingStatusKind> = new Set(["enabling", "disabling"])

export function loggingStatusKind(enabled: boolean, logState: LogStateView): LoggingStatusKind {
  const kind = logState.destination.kind
  if (kind === "fallback" || kind === "disabled") return "degraded"
  if (kind === "levelOff") return "levelOff"
  if (kind === "off") return enabled ? "enabling" : "off"
  // Attached this session: `directory` while the checkbox says stop means the
  // change is pending a restart, not that it already stopped.
  return enabled ? "healthy" : "disabling"
}

/**
 * The status row under the logging controls. Five states, five honest
 * sentences:
 *
 * - `off` is the user's own choice (the default). It says what is not
 *   happening and how to turn it on — never "degraded", because nothing failed.
 * - `fallback` really is writing to the named temp directory, so naming it is
 *   useful and the reason is what makes the fix obvious (usually permissions on
 *   the real log directory).
 * - `disabled` attached no logger at all. Naming `dir` there would point at a
 *   path nothing writes — and because the `Stdout` target lives inside the same
 *   plugin dispatch, there is no console stream to suggest either.
 * - `directory` is the healthy case; the caller does not render this row.
 */
function LoggingStatus({ logState, enabled }: { logState: LogStateView; enabled: boolean }) {
  const t = useT()
  const status = loggingStatusKind(enabled, logState)
  if (status === "off" || status === "levelOff" || status === "enabling" || status === "disabling") {
    return (
      <div className="settings-note-block" role="status">
        <span className="settings-warning-title">{t(`settings.logging.${status}.title`)}</span>
        <span className="settings-warning-note">{t(`settings.logging.${status}.note`)}</span>
      </div>
    )
  }
  // The healthy case needs no row: a status line on every normal launch is
  // noise, and `degraded` is the only field that would be false here anyway.
  if (status === "healthy") return null
  const fallback = logState.destination.kind === "fallback"
  return (
    <div className="settings-warning" role="status">
      <span className="settings-warning-title">
        {t("settings.logging.degraded.title")}
      </span>
      {fallback ? (
        <span className="settings-warning-note">
          {t("settings.logging.degraded.fallback")}
          {" "}
          <code className="settings-warning-path">{logState.dir}</code>
        </span>
      ) : (
        <span className="settings-warning-note">
          {t("settings.logging.degraded.disabled")}
        </span>
      )}
    </div>
  )
}

export function SettingsModal(props: SettingsModalProps) {
  const { isOpen, settings, onSave, onClose, listSystemFonts, logState, openUrl, onRestartToApplyLogging } = props
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

            <div className="settings-row">
              <label htmlFor="setting-auto-pair-brackets" className="settings-label">
                {t("settings.label.autoPairBrackets")}
              </label>
              <input
                id="setting-auto-pair-brackets"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.autoPair.brackets}
                onChange={e => update({
                  autoPair: { ...settings.autoPair, brackets: e.target.checked },
                })}
              />
            </div>

            <div className="settings-row">
              <label htmlFor="setting-auto-pair-quotes" className="settings-label">
                {t("settings.label.autoPairQuotes")}
              </label>
              <input
                id="setting-auto-pair-quotes"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.autoPair.quotes}
                onChange={e => update({
                  autoPair: { ...settings.autoPair, quotes: e.target.checked },
                })}
              />
            </div>

            <div className="settings-row">
              <label htmlFor="setting-auto-pair-markdown" className="settings-label">
                {t("settings.label.autoPairMarkdown")}
              </label>
              <input
                id="setting-auto-pair-markdown"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.autoPair.markdownSyntax}
                onChange={e => update({
                  autoPair: { ...settings.autoPair, markdownSyntax: e.target.checked },
                })}
              />
            </div>
          </div>

          {/* Export Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">{t("settings.section.export")}</h3>

            <div className="settings-row">
              <label htmlFor="setting-export-width" className="settings-label">
                {t("settings.label.exportWidth")}
              </label>
              <select
                id="setting-export-width"
                className="settings-select"
                value={settings.exportWidth}
                onChange={e => update({ exportWidth: Number(e.target.value) })}
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
                onChange={e => update({ exportScale: Number(e.target.value) as ExportScale })}
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
          </div>

          {/* Logging Section */}
          <div className="settings-section">
            <h3 className="settings-section-title">{t("settings.section.logging")}</h3>
            <div className="settings-row">
              <label htmlFor="setting-logging-enabled" className="settings-label">
                {t("settings.label.loggingEnabled")}
              </label>
              <input
                id="setting-logging-enabled"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.loggingEnabled}
                onChange={e => update({ loggingEnabled: e.target.checked })}
              />
            </div>
            {/* `install()` runs once at startup, so neither toggle can change
                this session; the notes are the honest half. */}
            <p className="settings-note">{t("settings.note.loggingEnabled")}</p>
            <div className="settings-row">
              <label htmlFor="setting-verbose-logging" className="settings-label">
                {t("settings.label.verboseLogging")}
              </label>
              <input
                id="setting-verbose-logging"
                type="checkbox"
                className="settings-checkbox"
                disabled={!settings.loggingEnabled}
                checked={settings.verboseLogging}
                onChange={e => update({ verboseLogging: e.target.checked })}
              />
            </div>
            <p className="settings-note">{t("settings.note.verboseLogging")}</p>
            {logState ? <LoggingStatus logState={logState} enabled={settings.loggingEnabled} /> : null}
            {/* The links are always here: someone whose logging is healthy still
                needs to know where the guide and the issue form are. Only the
                restart is conditional — it exists to apply a pending change. */}
            <div className="settings-row settings-actions">
              {logState && PENDING_LOGGING_STATUSES.has(loggingStatusKind(settings.loggingEnabled, logState)) ? (
                <>
                  {onRestartToApplyLogging ? (
                    <button
                      type="button"
                      className="settings-btn settings-btn-secondary"
                      onClick={onRestartToApplyLogging}
                    >
                      {t("settings.logging.restart")}
                    </button>
                  ) : null}
                </>
              ) : null}
              {/* Without these two links the feature ends at "logging is on" and
                  the user has no next step: where the file is, what to send, and
                  where to send it live in the guide. */}
              <button
                type="button"
                className="settings-link"
                onClick={() => openUrl?.(TROUBLESHOOTING_URL)}
              >
                {t("settings.logging.guide")}
              </button>
              <button
                type="button"
                className="settings-link"
                onClick={() => openUrl?.(ISSUES_URL)}
              >
                {t("settings.logging.reportIssue")}
              </button>
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
