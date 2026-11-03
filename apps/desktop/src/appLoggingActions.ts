/**
 * Settings → Logging actions that are more than a checkbox.
 *
 * Both toggles only take effect on the next launch (`install()` attaches the log
 * plugin once, during setup), so the panel offers "restart now" instead of
 * making the user quit and reopen by hand — the friction landed exactly on the
 * person who had just hit a bug and wanted evidence from *this* run.
 *
 * The restart reuses the update-restart flush protocol rather than a bare
 * process restart: `prepareUpdateRestart` runs the session-flush round (pending
 * materialization, session shards, queued log records) and never exits on
 * timeout, so a hung webview cannot lose edits or trap the user.
 */
import { errorMessage, type DesktopServices } from "./desktopServices"
import { t } from "./i18n"

/** Resolves the in-flight settings save; `false` means it never reached disk. */
export type FlushSettings = () => Promise<boolean>

/** Restart so a logging preference takes effect. Honest about what it does not
 *  guarantee: a timeout aborts the restart and says so. */
export async function restartToApplyLogging(
  services: DesktopServices,
  awaitSettings: FlushSettings = async () => true,
): Promise<void> {
  if (!services.confirmRestartForLogging?.()) return
  try {
    // The new process reads `settings.json`, so the preference must be on disk
    // before the process is replaced. Without this the restart can outrun the
    // save and come back with logging still off — the toggle would look applied
    // and do nothing. A fallback-only save (localStorage) is equally unusable
    // here, which is why the result is checked rather than assumed.
    if (!await awaitSettings()) {
      services.reportError(t("error.restart.settingsNotSaved"))
      return
    }
    const flushed = await services.prepareUpdateRestart?.()
    if (flushed?.kind !== "ready") {
      services.reportError(t("update.failure.flushTimeout"))
      return
    }
    await services.restartApp?.()
  } catch (error) {
    services.reportError(errorMessage(t("error.restart.failed"), error))
  }
}
