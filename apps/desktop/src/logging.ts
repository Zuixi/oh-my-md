/**
 * The `log_state` IPC payload, mirrored from `logging.rs::LogStateView`.
 *
 * The Rust side is the source of truth; this type exists so the Settings surface
 * can distinguish the three destinations. TypeScript cannot catch wire-format
 * drift (a renamed field compiles and reads `undefined` at runtime), so
 * `logging.rs` pins the serialized JSON in its own tests and
 * `SettingsModal.test.tsx` renders each variant.
 */

/** Which of the three mutually exclusive places this run's records go. */
export type LogDestinationKind = "directory" | "fallback" | "disabled"

export interface LogStateView {
  /** True whenever `destination.kind` is not `"directory"`. */
  readonly degraded: boolean
  /**
   * The resolved log directory. Empty when `destination.kind` is `"disabled"`:
   * no logger attached at all, so no directory holds this run's records.
   */
  readonly dir: string
  readonly destination: { readonly kind: LogDestinationKind }
}
