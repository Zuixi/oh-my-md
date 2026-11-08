/**
 * Remembers the latest settings write, so an action that replaces the process
 * can wait for it instead of racing it.
 *
 * Settings persist asynchronously (`void services.saveSettings(...)`), and the
 * restart-to-apply-logging path reads `settings.json` in the *new* process. A
 * write still in flight there, or one that only reached the localStorage
 * fallback, would leave the preference unchanged while the UI says otherwise.
 *
 * `false` means "did not reach disk": the caller must not act as if it did.
 */
import type { DesktopServices } from "./desktopServices"
import {
  loggingGenerationAfterChange,
  sanitizeSettings,
  type UserSettings,
} from "./settings"

export type SettingsSaveSlot = { current: Promise<boolean> }

export function trackSettingsSave(
  slot: SettingsSaveSlot,
  services: Pick<DesktopServices, "saveSettings">,
  settings: UserSettings,
): void {
  slot.current = slot.current.then(() => services.saveSettings?.(settings)).then(
    persisted => persisted ?? true,
    () => false,
  )
}

/**
 * The one settings-save pipeline App runs: derive the logging generation from
 * the toggle flip, sanitize, and queue a strictly ordered write.
 *
 * Returning the sanitized blob keeps one definition of "what was saved": the
 * caller updates its state from this value, never from the raw `next` it was
 * handed (which still carries the previous generation when a toggle flipped).
 */
export function persistSettingsChange(args: {
  current: UserSettings
  next: UserSettings
  slot: SettingsSaveSlot
  services: Pick<DesktopServices, "saveSettings">
}): UserSettings {
  const sanitized = sanitizeSettings({
    ...args.next,
    loggingGeneration: loggingGenerationAfterChange(args.current, args.next),
  })
  trackSettingsSave(args.slot, args.services, sanitized)
  return sanitized
}
