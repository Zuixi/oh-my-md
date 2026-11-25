import { useRef, useState, type KeyboardEvent } from "react"
import { Activity, FileOutput, SlidersHorizontal, Type, X } from "lucide-react"
import { Dialog } from "./Dialog"
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  sanitizeSettings,
  type DefaultEditorMode,
  type TabSize,
  type UserSettings,
} from "./settings"
import { localeOptions, useT, type StoredLocale } from "./i18n"
import type { LogStateView } from "./logging"
import { ExportSettingsSection } from "./ExportSettingsSection"
import { FontFamilyPicker } from "./FontFamilyPicker"
import {
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
  SettingsThemePicker,
} from "./SettingsControls"
import {
  SettingsDiagnosticsSection,
  loggingStatusKind,
  type LoggingStatusKind,
} from "./SettingsDiagnosticsSection"

export { loggingStatusKind, type LoggingStatusKind }

export type SettingsCategory = "general" | "editor" | "export" | "diagnostics"

const CATEGORIES: ReadonlyArray<{
  readonly id: SettingsCategory
  readonly labelKey:
    | "settings.section.general"
    | "settings.section.editor"
    | "settings.section.export"
    | "settings.section.logging"
  readonly icon: typeof SlidersHorizontal
}> = [
  { id: "general", labelKey: "settings.section.general", icon: SlidersHorizontal },
  { id: "editor", labelKey: "settings.section.editor", icon: Type },
  { id: "export", labelKey: "settings.section.export", icon: FileOutput },
  { id: "diagnostics", labelKey: "settings.section.logging", icon: Activity },
]

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

export function SettingsModal(props: SettingsModalProps) {
  const { isOpen, settings, onSave, onClose, listSystemFonts, logState, openUrl, onRestartToApplyLogging } = props
  const t = useT()
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general")
  // System font families: fetched once on the first picker open, then cached
  // (undefined = never requested, null = enumeration failed, array = loaded).
  // The picker stays mounted while the modal is open, so open/close reuses it.
  const fontFamiliesCacheRef = useRef<string[] | null | undefined>(undefined)
  const [fontFamilies, setFontFamilies] = useState<string[] | null>([])
  const [fontFamiliesLoading, setFontFamiliesLoading] = useState(false)

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

  const update = (partial: Partial<UserSettings>) => {
    onSave(sanitizeSettings({ ...settings, ...partial }))
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = -1
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % CATEGORIES.length
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + CATEGORIES.length) % CATEGORIES.length
    } else if (event.key === "Home") {
      nextIndex = 0
    } else if (event.key === "End") {
      nextIndex = CATEGORIES.length - 1
    }
    if (nextIndex === -1) return
    event.preventDefault()
    setActiveCategory(CATEGORIES[nextIndex].id)
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[nextIndex]?.focus()
  }

  const defaultModeOptions: ReadonlyArray<{ readonly value: DefaultEditorMode; readonly label: string }> = [
    { value: "live", label: t("settings.mode.live") },
    { value: "source", label: t("settings.mode.source") },
  ]

  const tabSizeOptions: ReadonlyArray<{ readonly value: TabSize; readonly label: string }> = [
    { value: 2, label: t("settings.tabSize.twoSpaces") },
    { value: 4, label: t("settings.tabSize.fourSpaces") },
  ]

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={t("settings.aria.dialog")}
      className="settings-modal"
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

      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.aria.categories")}
        >
          {CATEGORIES.map((category, index) => {
            const Icon = category.icon
            const selected = activeCategory === category.id
            return (
              <button
                key={category.id}
                type="button"
                role="tab"
                id={`settings-tab-${category.id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${category.id}`}
                tabIndex={selected ? 0 : -1}
                className={
                  selected ? "settings-nav-item settings-nav-item-active" : "settings-nav-item"
                }
                onClick={() => setActiveCategory(category.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
              >
                <Icon size={15} className="settings-nav-icon" aria-hidden="true" />
                <span>{t(category.labelKey)}</span>
              </button>
            )
          })}
        </div>

        <div
          className="settings-content"
          role="tabpanel"
          id={`settings-panel-${activeCategory}`}
          aria-labelledby={`settings-tab-${activeCategory}`}
        >
          {activeCategory === "general" ? (
            <div className="settings-section">
              <h3 className="settings-section-title">{t("settings.section.general")}</h3>

              <h4 id="setting-theme-label" className="settings-subheading">
                {t("settings.label.theme")}
              </h4>
              <div className="settings-card settings-card-padded">
                <SettingsThemePicker
                  labelledBy="setting-theme-label"
                  value={settings.theme}
                  onChange={theme => update({ theme })}
                />
              </div>

              <h4 className="settings-subheading">{t("settings.section.language")}</h4>
              <div className="settings-card">
                <SettingsRow
                  htmlFor="setting-locale"
                  label={t("settings.section.language")}
                  control={(
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
                  )}
                />

                <SettingsRow
                  labelId="setting-default-mode-label"
                  label={t("settings.label.defaultMode")}
                  control={(
                    <SettingsSegmented
                      labelledBy="setting-default-mode-label"
                      value={settings.defaultMode}
                      options={defaultModeOptions}
                      onChange={defaultMode => update({ defaultMode })}
                    />
                  )}
                />
              </div>
            </div>
          ) : null}

          {activeCategory === "editor" ? (
            <div className="settings-section">
              <h3 className="settings-section-title">{t("settings.section.editor")}</h3>

              <h4 className="settings-subheading">{t("settings.editor.group.typography")}</h4>
              <div className="settings-card">
                <SettingsRow
                  htmlFor="setting-font-family"
                  label={t("settings.label.fontFamily")}
                  control={(
                    <FontFamilyPicker
                      value={settings.fontFamily}
                      families={fontFamilies}
                      loading={fontFamiliesLoading}
                      onOpen={handleFontPickerOpen}
                      onSelect={cssValue => update({ fontFamily: cssValue })}
                    />
                  )}
                />

                <SettingsRow
                  htmlFor="setting-font-size"
                  label={t("settings.label.fontSize")}
                  control={(
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
                  )}
                />

                <SettingsRow
                  htmlFor="setting-line-height"
                  label={t("settings.label.lineHeight")}
                  control={(
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
                  )}
                />

                <SettingsRow
                  labelId="setting-tab-size-label"
                  label={t("settings.label.tabSize")}
                  control={(
                    <SettingsSegmented
                      labelledBy="setting-tab-size-label"
                      value={settings.tabSize}
                      options={tabSizeOptions}
                      onChange={tabSize => update({ tabSize })}
                    />
                  )}
                />
              </div>

              <h4 className="settings-subheading">{t("settings.editor.group.writing")}</h4>
              <div className="settings-card">
                <SettingsRow
                  htmlFor="setting-spellcheck"
                  label={t("settings.label.spellcheck")}
                  control={(
                    <SettingsSwitch
                      id="setting-spellcheck"
                      checked={settings.spellcheck}
                      onChange={spellcheck => update({ spellcheck })}
                    />
                  )}
                />

                <SettingsRow
                  htmlFor="setting-auto-pair-brackets"
                  label={t("settings.label.autoPairBrackets")}
                  control={(
                    <SettingsSwitch
                      id="setting-auto-pair-brackets"
                      checked={settings.autoPair.brackets}
                      onChange={brackets => update({
                        autoPair: { ...settings.autoPair, brackets },
                      })}
                    />
                  )}
                />

                <SettingsRow
                  htmlFor="setting-auto-pair-quotes"
                  label={t("settings.label.autoPairQuotes")}
                  control={(
                    <SettingsSwitch
                      id="setting-auto-pair-quotes"
                      checked={settings.autoPair.quotes}
                      onChange={quotes => update({
                        autoPair: { ...settings.autoPair, quotes },
                      })}
                    />
                  )}
                />

                <SettingsRow
                  htmlFor="setting-auto-pair-markdown"
                  label={t("settings.label.autoPairMarkdown")}
                  control={(
                    <SettingsSwitch
                      id="setting-auto-pair-markdown"
                      checked={settings.autoPair.markdownSyntax}
                      onChange={markdownSyntax => update({
                        autoPair: { ...settings.autoPair, markdownSyntax },
                      })}
                    />
                  )}
                />
              </div>
            </div>
          ) : null}

          {activeCategory === "export" ? (
            <ExportSettingsSection settings={settings} onUpdate={update} />
          ) : null}

          {activeCategory === "diagnostics" ? (
            <SettingsDiagnosticsSection
              settings={settings}
              onUpdate={update}
              logState={logState}
              openUrl={openUrl}
              onRestartToApplyLogging={onRestartToApplyLogging}
            />
          ) : null}
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
    </Dialog>
  )
}
