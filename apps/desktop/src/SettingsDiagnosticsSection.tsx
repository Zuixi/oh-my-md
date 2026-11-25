import { ISSUES_URL, TROUBLESHOOTING_URL } from "./constants"
import { useT } from "./i18n"
import type { LogStateView } from "./logging"
import type { UserSettings } from "./settings"
import { SettingsRow, SettingsSwitch } from "./SettingsControls"

/**
 * What the logging status banner must say, given the toggle and the state the
 * engine resolved at startup.
 *
 * The two can disagree for one session, because `install()` runs once: flipping
 * the toggle writes the setting but cannot attach or detach the plugin.
 */
export type LoggingStatusKind = "off" | "levelOff" | "enabling" | "disabling" | "healthy" | "degraded"

const PENDING_LOGGING_STATUSES: ReadonlySet<LoggingStatusKind> = new Set(["enabling", "disabling"])

export function loggingStatusKind(enabled: boolean, logState: LogStateView): LoggingStatusKind {
  const kind = logState.destination.kind
  if (kind === "fallback" || kind === "disabled") return "degraded"
  if (kind === "levelOff") return "levelOff"
  if (kind === "off") return enabled ? "enabling" : "off"
  // Attached this session: `directory` while the switch says stop means the
  // change is pending a restart, not that it already stopped.
  return enabled ? "healthy" : "disabling"
}

function LoggingStatus({ logState, enabled }: { logState: LogStateView; enabled: boolean }) {
  const t = useT()
  const status = loggingStatusKind(enabled, logState)
  if (status === "off" || status === "levelOff" || status === "enabling" || status === "disabling") {
    return (
      <div className="settings-info-box" role="status">
        <span className="settings-info-title">{t(`settings.logging.${status}.title`)}</span>
        <span className="settings-info-note">{t(`settings.logging.${status}.note`)}</span>
      </div>
    )
  }
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

export interface SettingsDiagnosticsSectionProps {
  settings: UserSettings
  onUpdate: (partial: Partial<UserSettings>) => void
  logState?: LogStateView | null
  openUrl?: (url: string) => void
  onRestartToApplyLogging?: () => void
}

export function SettingsDiagnosticsSection(props: SettingsDiagnosticsSectionProps) {
  const { settings, onUpdate, logState, openUrl, onRestartToApplyLogging } = props
  const t = useT()
  const restartPending = Boolean(
    logState && PENDING_LOGGING_STATUSES.has(loggingStatusKind(settings.loggingEnabled, logState)),
  )

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.section.logging")}</h3>

      <div className="settings-card">
        <SettingsRow
          htmlFor="setting-logging-enabled"
          label={t("settings.label.loggingEnabled")}
          note={t("settings.note.loggingEnabled")}
          control={(
            <SettingsSwitch
              id="setting-logging-enabled"
              checked={settings.loggingEnabled}
              onChange={loggingEnabled => onUpdate({ loggingEnabled })}
            />
          )}
        />
        <SettingsRow
          htmlFor="setting-verbose-logging"
          label={t("settings.label.verboseLogging")}
          note={t("settings.note.verboseLogging")}
          control={(
            <SettingsSwitch
              id="setting-verbose-logging"
              disabled={!settings.loggingEnabled}
              checked={settings.verboseLogging}
              onChange={verboseLogging => onUpdate({ verboseLogging })}
            />
          )}
        />
      </div>

      {logState ? <LoggingStatus logState={logState} enabled={settings.loggingEnabled} /> : null}

      <div className="settings-actions">
        {restartPending && onRestartToApplyLogging ? (
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={onRestartToApplyLogging}
          >
            {t("settings.logging.restart")}
          </button>
        ) : null}
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
  )
}
