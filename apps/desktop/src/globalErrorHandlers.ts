/**
 * Global error capture (Task 7).
 *
 * In a packaged build there is no devtools, so an uncaught frontend error
 * currently vanishes without a trace. This is the only channel it has left.
 * Two rules shape the module:
 *
 *   1. A fatal record must not wait for the facade's delivery timer
 *      (`LOG_FLUSH_INTERVAL_MS`) — a dying webview never reaches it. So
 *      `reportFatal` logs and then kicks `flush()`, which moves the queue into
 *      `send` synchronously, before its first `await`, i.e. the IPC call is
 *      initiated in the same task. Tauri v2 has no synchronous IPC
 *      (`@tauri-apps/api` exposes only `async function invoke`), so this
 *      removes the timer delay but cannot guarantee delivery; the guaranteed
 *      path remains the exit flush that rides the session-flush round
 *      (Task 8). Callers deliberately do not await it.
 *   2. Nothing here may throw into a listener. A throwing error handler is
 *      worse than no handler: it replaces the original failure with its own.
 */
import type { Logger } from "./logger"

/** Label every captured record carries, so log readers can filter this channel. */
const CAPTURE_TARGET = "window"

/**
 * Renders an arbitrary thrown value as text — a `message` line plus the stack
 * for an `Error`. A rejection reason is
 * `unknown` at runtime — string, number, `undefined`, or an object that may be
 * circular (where `JSON.stringify` throws) and whose `toString` may throw too.
 * Nothing in here may throw.
 */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.message}\n${value.stack ?? ""}`.trim()
  }
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    const json = JSON.stringify(value)
    // `JSON.stringify` returns `undefined` (not a string) for values with no
    // JSON form — functions, symbols — despite its TypeScript signature.
    if (typeof json === "string") return json
  } catch {
    // Circular or otherwise unserializable; fall through to the coarse form.
  }
  try {
    return String(value)
  } catch {
    // Fall through to a form that invokes no user code.
  }
  try {
    return Object.prototype.toString.call(value)
  } catch {
    return "(unprintable value)"
  }
}

/**
 * Logs a fatal record and dispatches it without waiting for the facade's
 * flush timer. Never throws: it runs inside the webview's last-chance handlers
 * and inside React's commit phase.
 */
export function reportFatal(logger: Logger, target: string, message: string): void {
  try {
    logger.error(target, message)
  } catch {
    // Logging must never break its caller (spec §3.9).
    return
  }
  try {
    // `flush()` hands the batch to `send` synchronously, so the IPC call is
    // initiated in this task rather than 250 ms later. See the module doc for
    // why this is the honest maximum and why awaiting it would change nothing.
    void logger.flush().catch(() => {})
  } catch {
    // A logger that cannot flush has still been given the record.
  }
}

/** The rejection event the webview delivers; happy-dom 16 has no constructor
 *  for it, so tests dispatch a plain `Event` with the same `reason` shape. */
interface RejectionEventLike extends Event {
  readonly reason?: unknown
}

/** `filename:line:column` for a script error that carries no `Error` at all. */
function sourcePosition(event: ErrorEvent): string {
  if (!event.filename) return ""
  return ` (${event.filename}:${event.lineno}:${event.colno})`
}

/** One live installation per window, so installing twice cannot double-report. */
const installed = new WeakMap<Window, () => void>()

/**
 * Forwards uncaught errors and unhandled rejections to the logger, bypassing
 * the facade's flush queue delay (see the module doc).
 *
 * Idempotent: a second install on the same window returns the existing
 * uninstall function and registers nothing — the first logger wins, since one
 * hook cannot report to two loggers without double-reporting. The returned
 * function removes both listeners and re-arms the window for a later install.
 */
export function installGlobalErrorHandlers(logger: Logger, win: Window = window): () => void {
  const existing = installed.get(win)
  if (existing) return existing

  const onError = (event: ErrorEvent): void => {
    // A cross-origin script error arrives as "Script error." with `error` null
    // (the WebIDL default); the source position is then the only detail there
    // is. When an error is present its stack is strictly more useful.
    const error: unknown = event.error
    const detail = describeThrown(error)
    const at = error === undefined || error === null ? sourcePosition(event) : ""
    reportFatal(logger, CAPTURE_TARGET, `uncaught: ${event.message}${at}${detail ? `\n${detail}` : ""}`)
  }

  const onRejection = (event: Event): void => {
    const detail = describeThrown((event as RejectionEventLike).reason)
    reportFatal(
      logger,
      CAPTURE_TARGET,
      detail ? `unhandled rejection: ${detail}` : "unhandled rejection",
    )
  }

  win.addEventListener("error", onError)
  win.addEventListener("unhandledrejection", onRejection)

  const uninstall = (): void => {
    installed.delete(win)
    win.removeEventListener("error", onError)
    win.removeEventListener("unhandledrejection", onRejection)
  }
  installed.set(win, uninstall)
  return uninstall
}
