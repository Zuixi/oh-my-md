/**
 * Frontend logging facade.
 *
 * Four layers bound what this can cost the webview (spec §3.9):
 *   1. dedupe   — consecutive identical records collapse into a repeat count
 *   2. rate     — a token bucket caps records/second
 *   3. breaker  — enough drops and the facade goes quiet for a cooldown
 *   4. (Rust)   — a per-window budget on the command itself
 *
 * `error` bypasses 2, 3 and 4: a fatal record must survive a warnings storm.
 * Layer 1 still applies to it, so a fatal error in a render loop is not an
 * unbounded flood.
 *
 * The facade never schedules its own delivery — callers decide when a batch is
 * worth an IPC round trip and await `flush()`. The guaranteed path is the exit
 * flush that rides the existing session-flush round (Task 8).
 */
import {
  LOG_ALWAYS_PASS_LEVEL,
  LOG_BREAKER_COOLDOWN_MS,
  LOG_BREAKER_DROPS,
  LOG_BREAKER_WINDOW_MS,
  LOG_RATE_LIMIT_PER_SEC,
} from "./constants"

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"

export interface LogRecord {
  level: LogLevel
  target: string
  message: string
}

export interface Logger {
  error(target: string, message: string): void
  warn(target: string, message: string): void
  info(target: string, message: string): void
  debug(target: string, message: string): void
  trace(target: string, message: string): void
  /** Delivers everything queued. Never rejects. */
  flush(): Promise<void>
}

export interface LoggerDeps {
  send: (records: LogRecord[]) => Promise<void>
  now: () => number
  /** Mirrors to the console in dev; defaults to `import.meta.env.DEV`. */
  mirrorToConsole?: boolean
}

/** The open run of identical records, before its repeat count is materialized. */
interface PendingRun {
  level: LogLevel
  target: string
  message: string
  count: number
}

/** Devtools has no `trace` channel, so trace mirrors on `debug`. */
function mirrorRecord(record: LogRecord): void {
  const line = `[${record.target}] ${record.message}`
  switch (record.level) {
    case "error":
      console.error(line)
      break
    case "warn":
      console.warn(line)
      break
    case "info":
      console.info(line)
      break
    case "debug":
    case "trace":
      console.debug(line)
      break
  }
}

export function createLogger(deps: LoggerDeps): Logger {
  const mirror = deps.mirrorToConsole ?? Boolean(import.meta.env?.DEV)
  const queue: LogRecord[] = []
  let pending: PendingRun | null = null
  let inFlight: Promise<void> | null = null

  let bucketStart = deps.now()
  let bucketUsed = 0
  let dropWindowStart = deps.now()
  let drops = 0
  let openUntil = 0

  function breakerOpen(): boolean {
    return deps.now() < openUntil
  }

  /**
   * Moves the open repeat run into the queue, turning its count into the
   * `Last message repeated N times` suffix. The only place that does so.
   */
  function sealPending(): void {
    if (!pending) return
    queue.push({
      level: pending.level,
      target: pending.target,
      message:
        pending.count > 1
          ? `${pending.message} (last message repeated ${pending.count} times)`
          : pending.message,
    })
    pending = null
  }

  function push(record: LogRecord): void {
    if (
      pending
      && pending.level === record.level
      && pending.target === record.target
      && pending.message === record.message
    ) {
      pending.count += 1
      return
    }
    sealPending()
    pending = { ...record, count: 1 }
  }

  /** Opens the breaker and queues exactly one summary line for the trip. */
  function announceSuppression(now: number): void {
    openUntil = now + LOG_BREAKER_COOLDOWN_MS
    drops = 0
    dropWindowStart = now
    // Queued directly, not through `push`: the summary is a state change, not
    // part of a repeat run, and must survive layer 1 as its own line.
    sealPending()
    queue.push({
      level: "warn",
      target: "logger",
      message: `logging suppressed for ${LOG_BREAKER_COOLDOWN_MS}ms after ${LOG_BREAKER_DROPS} drops`,
    })
  }

  /**
   * Counts `count` records the facade refused to offer. The trip is a single
   * decision over the accumulated count, so a burst can never emit a summary
   * per rejected record.
   */
  function noteDrops(count: number): void {
    if (count <= 0) return
    const now = deps.now()
    if (now - dropWindowStart > LOG_BREAKER_WINDOW_MS) {
      dropWindowStart = now
      drops = 0
    }
    drops += count
    if (drops >= LOG_BREAKER_DROPS) announceSuppression(now)
  }

  function takeToken(): boolean {
    const now = deps.now()
    if (now - bucketStart >= 1000) {
      bucketStart = now
      bucketUsed = 0
    }
    bucketUsed += 1
    return bucketUsed <= LOG_RATE_LIMIT_PER_SEC
  }

  function emit(level: LogLevel, target: string, message: string): void {
    try {
      // `error` is the green channel: it skips layers 2 and 3 (and is the one
      // level Rust layer 4 never collapses), so it never counts as a drop and
      // a steady trickle of fatal records cannot pin the breaker open.
      if (level !== LOG_ALWAYS_PASS_LEVEL) {
        if (breakerOpen()) {
          noteDrops(1)
          return
        }
        if (!takeToken()) {
          noteDrops(1)
          return
        }
      }
      push({ level, target, message })
    } catch {
      // Logging must never break its caller (spec §3.9).
    }
  }

  async function flush(): Promise<void> {
    if (inFlight) await inFlight
    sealPending()
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    if (mirror) {
      for (const record of batch) mirrorRecord(record)
    }
    // The async wrapper catches a synchronous throw from `send` as well as a
    // rejection, so `flush()` can never reject.
    inFlight = (async () => {
      await deps.send(batch)
    })()
      .catch(() => {
        // A lost batch must never reach the caller. Count it as drops so a
        // dead IPC trips the breaker instead of being hammered every flush.
        noteDrops(batch.length)
      })
      .finally(() => {
        inFlight = null
      })
    await inFlight
  }

  return {
    error: (target, message) => { emit("error", target, message) },
    warn: (target, message) => { emit("warn", target, message) },
    info: (target, message) => { emit("info", target, message) },
    debug: (target, message) => { emit("debug", target, message) },
    trace: (target, message) => { emit("trace", target, message) },
    flush,
  }
}

let globalLogger: Logger | null = null

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger
}

export function getGlobalLogger(): Logger {
  if (!globalLogger) {
    globalLogger = createLogger({
      now: () => Date.now(),
      send: async () => {
        // No transport installed yet; Task 7 replaces this global logger.
      },
    })
  }
  return globalLogger
}
