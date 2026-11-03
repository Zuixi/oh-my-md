/**
 * Diagnostics commands from the palette and menu.
 *
 * Both failures are user-visible rejections — a diagnostics export is the one
 * action whose whole purpose is to produce a file, so swallowing its failure
 * would leave the user with nothing and no reason. Keeping them here (rather
 * than inline in `App.tsx`) keeps the shell growth-frozen.
 */
import { errorMessage, type DesktopServices } from "./desktopServices"
import { t } from "./i18n"
import { flushLogsForDiagnostics } from "./logging"

/** Export the support bundle; a rejection reaches the standard error channel.
 *
 * The queue is flushed first (bounded, see `flushLogsForDiagnostics`) so the
 * bundle contains what just happened. That step belongs to this use case, not to
 * the IPC layer: `services.exportDiagnostics` only asks for a destination and
 * invokes the command. */
export async function exportDiagnostics(services: DesktopServices): Promise<void> {
  try {
    await flushLogsForDiagnostics()
    await services.exportDiagnostics?.()
  } catch (error) {
    services.reportError(errorMessage(t("error.export.diagnosticsFailed"), error))
  }
}

/** Reveal the resolved log directory; a disabled destination rejects by design. */
export async function openLogFolder(services: DesktopServices): Promise<void> {
  try {
    await services.openLogDir?.()
  } catch (error) {
    services.reportError(errorMessage(t("error.openLogFolderFailed"), error))
  }
}
