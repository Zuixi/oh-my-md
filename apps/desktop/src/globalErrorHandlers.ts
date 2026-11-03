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
 *      removes the timer delay but cannot guarantee delivery; clean exits also
 *      request a bounded flush through the session-flush round (Task 8).
 *      Callers deliberately do not await it.
 *   2. Nothing here may throw into a listener. A throwing error handler is
 *      worse than no handler: it replaces the original failure with its own.
 */
import type { Logger } from "./logger"

/** Label every captured record carries, so log readers can filter this channel. */
const CAPTURE_TARGET = "window"

/**
 * Renders an arbitrary thrown value as text that is safe to write to the log.
 *
 * The record must stay diagnosable **and** must never carry user content or
 * credentials. An `Error` therefore contributes its message, its stack, and its
 * `name`; anything else is reduced to coarse structural facts — constructor
 * name, keys, and the message of a nested `cause`/`error` if it is an `Error`.
 * Arbitrary own properties are never serialized: a rejected fetch body, an IPC
 * payload, or a thrown object literal can hold document text or a token, and
 * the export flow promises the bundle contains no document content.
 *
 * Nothing in here may throw. Every step is guarded, including the `Error`
 * branch: `instanceof` walks the prototype chain and `.message` is a property
 * read, so a `Proxy` can make both throw (a revoked `Proxy` throws from
 * `instanceof` itself; a `Proxy`-wrapped `Error` passes and then throws on the
 * read). The consequence of an escape is not a lost log line — inside
 * `componentDidCatch` it has no boundary above it, so React unmounts the root
 * and the user gets a blank window instead of the recovery surface.
 */
export function describeThrown(value: unknown): string {
  const error = asError(value)
  if (error) {
    return describeError(error)
  }
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value !== "object") {
    // A number, boolean, symbol, or function: no user payload can hide here,
    // and the primitive itself is the useful fact.
    try {
      return String(value)
    } catch {
      return "(unprintable value)"
    }
  }
  return describeObject(value)
}

/**
 * An `Error`'s message and stack, with every read guarded: a `Proxy` can pass
 * `instanceof` and then throw on `.message`/`.stack`. Falling through to
 * `describeObject` keeps the record and never escapes into the listener.
 */
function describeError(error: Error): string {
  let message = ""
  let stack = ""
  try {
    message = typeof error.message === "string" ? error.message : ""
  } catch {
    return describeObject(error)
  }
  try {
    stack = typeof error.stack === "string" ? error.stack : ""
  } catch {
    stack = ""
  }
  return `${message}\n${stack}`.trim() || "(error with no message)"
}

/** The value as an `Error`, or `null` when it is not one (or cannot be read). */
function asError(value: unknown): Error | null {
  try {
    return value instanceof Error ? value : null
  } catch {
    // A revoked `Proxy`, or one whose `getPrototypeOf` trap throws.
    return null
  }
}

/**
 * Coarse, content-free description of a thrown non-`Error` object.
 *
 * Shape only: the constructor name, own enumerable key names (never values),
 * and — when a `cause`/`error` property is itself an `Error` — that error's
 * `name` and `message`. That last part is what keeps
 * `Promise.reject(new SomeError())` wrappers diagnosable without opening the
 * door to arbitrary payloads.
 */
function describeObject(value: object): string {
  // Containers are reported by size, never enumerated. A rejected array or
  // `Map` is a realistic shape (a search result, a paste batch), and
  // `Object.keys` on a million-element array materializes a million strings —
  // ~25 ms of jank inside an error handler, before the queue's length cap can
  // do anything. Size is the diagnosable fact; the elements are payload.
  const container = describeContainer(value)
  if (container) return container
  const parts: string[] = []
  const name = constructorName(value)
  if (name) parts.push(name)
  const keys = safeKeys(value)
  if (keys.length > 0) parts.push(`keys=[${keys.slice(0, MAX_REPORTED_KEYS).join(",")}]`)
  for (const property of ["cause", "error"]) {
    const nested = nestedError(value, property)
    if (nested) parts.push(`${property}=${nested}`)
  }
  return parts.length > 0 ? parts.join(" ") : "(unrecognized thrown value)"
}

/** The size of an array/Map/Set, which is described instead of enumerated. */
function describeContainer(value: object): string | null {
  try {
    if (Array.isArray(value)) return `Array(${value.length})`
    if (value instanceof Map) return `Map(${value.size})`
    if (value instanceof Set) return `Set(${value.size})`
  } catch {
    // A Proxy wrapping one of these may throw on `size`/`length`.
    return null
  }
  return null
}

/** How many own key names a coarsely described value reports. Enumeration cost
 *  still scales with the object's own key count (V8 builds an enum cache even
 *  for an early-exit loop), so the containers above are skipped outright. */
const MAX_REPORTED_KEYS = 12

function constructorName(value: object): string {
  try {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name
    return typeof name === "string" ? name.slice(0, MAX_CONSTRUCTOR_CHARS) : ""
  } catch {
    return ""
  }
}

/** Longest constructor name reported; a crafted one must not bloat a record. */
const MAX_CONSTRUCTOR_CHARS = 64

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value).map(key => key.slice(0, MAX_KEY_CHARS))
  } catch {
    return []
  }
}

/** Longest property name reported; names are shape, not payload. */
const MAX_KEY_CHARS = 64

function nestedError(value: object, property: string): string | null {
  try {
    const nested = (value as Record<string, unknown>)[property]
    const error = asError(nested)
    if (!error) return null
    const name = typeof error.name === "string" ? error.name.slice(0, MAX_CONSTRUCTOR_CHARS) : "Error"
    return `${name}: ${error.message}`
  } catch {
    return null
  }
}

/** One immediate delivery request per logger while its transport is pending. */
const pendingFatalFlushes = new WeakSet<Logger>()

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
  if (pendingFatalFlushes.has(logger)) return
  pendingFatalFlushes.add(logger)
  try {
    // `flush()` initiates IPC in this task when no batch is already pending.
    // Later fatal records join the bounded queue, without adding more waiters.
    void logger.flush().catch(() => {}).finally(() => { pendingFatalFlushes.delete(logger) })
  } catch {
    pendingFatalFlushes.delete(logger)
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
