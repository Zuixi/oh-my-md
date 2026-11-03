import type { UpdateFailureKind } from "./updateCoordinator"
import { getGlobalLogger } from "./logger"

/**
 * The `log_state` IPC payload, mirrored from `logging.rs::LogStateView`.
 *
 * The Rust side is the source of truth; this type exists so the Settings surface
 * can distinguish every destination (including `off`, the user's own choice). TypeScript cannot catch wire-format
 * drift (a renamed field compiles and reads `undefined` at runtime), so
 * `logging.rs` pins the serialized JSON in its own tests and
 * `SettingsModal.test.tsx` renders each variant.
 */

/** Which mutually exclusive place this run's records go. `off` is the user's
 * choice, not a failure: nothing was created and nothing is written. */
export type LogDestinationKind = "directory" | "fallback" | "disabled" | "off" | "levelOff"

export interface LogStateView {
  /** True for a failed destination (`fallback` / `disabled`); `off` is not a
   *  failure, it is the user's own choice and must not be reported as one. */
  readonly degraded: boolean
  /**
   * The resolved log directory. Empty when `destination.kind` is `"disabled"`:
   * no logger attached at all, so no directory holds this run's records.
   */
  readonly dir: string
  readonly destination: { readonly kind: LogDestinationKind }
}

const DIAGNOSTICS_LOG_FLUSH_TIMEOUT_MS = 1000

export function logUpdateStartupFailure(failure: UpdateFailureKind): void {
  getGlobalLogger().warn("updates", `startup check failed: ${failure}`)
}

/** Best effort: include recent failures, but keep support export available even
 * when log IPC is stuck. This deadline is independent of the native quit gate. */
export async function flushLogsForDiagnostics(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      flushLogs(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, DIAGNOSTICS_LOG_FLUSH_TIMEOUT_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Drained within the existing native quit deadline. Even a replaced or
 * throwing logger must not prevent the session-flush acknowledgement. */
export async function flushLogs(): Promise<void> {
  try {
    await getGlobalLogger().flush()
  } catch {
    // Quit continues; there is no independent transport to report this through.
  }
}
