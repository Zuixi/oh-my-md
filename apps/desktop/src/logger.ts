/**
 * Frontend logging facade.
 *
 * Four layers bound what this can cost the webview (spec §3.9):
 *   1. dedupe   — consecutive identical records collapse into a repeat count
 *   2. rate     — a token bucket caps records/second
 *   3. breaker  — enough drops and the facade goes quiet for a cooldown
 *   4. (Rust)   — separate process budgets for ordinary and fatal records
 *
 * `error` bypasses the ordinary rate limit and breaker. It still obeys the
 * bounded queue and message limits; Rust provides a separate finite error
 * reserve. Overflow is summarized rather than allowed to grow without bound.
 *
 * The facade schedules delivery during normal operation. Clean exit also
 * requests a flush through the existing native session-flush deadline.
 * Abrupt termination or a stalled transport can still lose queued records.
 */
import {
  LOG_ALWAYS_PASS_LEVEL,
  LOG_BREAKER_COOLDOWN_MS,
  LOG_BREAKER_DROPS,
  LOG_BREAKER_WINDOW_MS,
  LOG_FLUSH_INTERVAL_MS,
  LOG_RATE_LIMIT_PER_SEC,
  LOG_MAX_BATCH_RECORDS,
  LOG_MAX_MESSAGE_CHARS,
  LOG_MAX_TARGET_CHARS,
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
  /** Delivers the retained records and omission summary. Never rejects. */
  flush(): Promise<void>
}

export interface LoggerDeps {
  send: (records: LogRecord[]) => Promise<void>
  now: () => number
  /** Mirrors to the console in dev; defaults to `import.meta.env.DEV`. */
  mirrorToConsole?: boolean
  /**
   * Arms the facade's one-shot delivery timer; defaults to a real
   * `setTimeout(run, LOG_FLUSH_INTERVAL_MS)`. Injected so tests reach the timer
   * path deterministically instead of by sleeping.
   */
  scheduleFlush?: (run: () => void) => void
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
  const scheduleFlush =
    deps.scheduleFlush
    ?? ((run: () => void) => {
      setTimeout(run, LOG_FLUSH_INTERVAL_MS)
    })
  const queue: LogRecord[] = []
  let omitted = 0
  let pending: PendingRun | null = null
  let inFlight: Promise<void> | null = null
  // At most one delivery timer is armed at a time; the generation invalidates a
  // timer whose queue already drained, so a late callback is a no-op.
  let flushTimerArmed = false
  let flushTimerGeneration = 0

  let bucketStart = deps.now()
  let bucketUsed = 0
  let dropWindowStart = deps.now()
  let drops = 0
  let openUntil = 0

  function breakerOpen(): boolean {
    return deps.now() < openUntil
  }

  /**
   * Arms the one-shot delivery timer the first time a record lands in an empty
   * queue; further records in the same batch reuse it. Nothing is armed while
   * nothing is queued.
   */
  function armFlushTimer(): void {
    if (flushTimerArmed || inFlight) return
    flushTimerArmed = true
    const generation = ++flushTimerGeneration
    try {
      scheduleFlush(() => {
        if (!flushTimerArmed || generation !== flushTimerGeneration) return
        flushTimerArmed = false
        void flush()
      })
    } catch {
      // A scheduler that refuses to arm must not wedge delivery: stay unarmed
      // so the next record can try again.
      if (generation === flushTimerGeneration) clearFlushTimer()
    }
  }

  /** Forgets the armed timer; the queue drained, so a late fire must not send. */
  function clearFlushTimer(): void {
    flushTimerArmed = false
    flushTimerGeneration += 1
  }

  /**
   * Moves the open repeat run into the queue, turning its count into the
   * `Last message repeated N times` suffix. The only place that does so.
   */
  function enqueue(record: LogRecord): void {
    // Reserve one slot for an omission summary. Keep fatal records in preference
    // to ordinary traffic, and retain the latest failure if the error reserve fills.
    if (queue.length < LOG_MAX_BATCH_RECORDS - 1) {
      queue.push(record)
      return
    }
    omitted += 1
    if (record.level !== "error") return
    const ordinary = queue.findIndex(item => item.level !== "error")
    if (ordinary >= 0) queue.splice(ordinary, 1)
    else queue.pop()
    queue.push(record)
  }

  function sealPending(): void {
    if (!pending) return
    enqueue({
      level: pending.level,
      target: pending.target,
      message:
        pending.count > 1
          ? boundedText(`${pending.message} (last message repeated ${pending.count} times)`, LOG_MAX_MESSAGE_CHARS)
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
    enqueue({
      level: "warn",
      target: "logger",
      message: `logging suppressed for ${LOG_BREAKER_COOLDOWN_MS}ms after ${LOG_BREAKER_DROPS} drops`,
    })
    // The summary is queued outside `emit`, so it needs its own arming.
    armFlushTimer()
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
    if (drops >= LOG_BREAKER_DROPS && !breakerOpen()) announceSuppression(now)
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
      // Fatal records bypass ordinary suppression, but retain the hard queue
      // bound. The native sink has a separate finite error reserve.
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
      push({ level, target: truncateText(target, LOG_MAX_TARGET_CHARS), message: boundedText(message, LOG_MAX_MESSAGE_CHARS) })
      // The first record in an empty queue arms delivery; repeats just extend
      // the run the armed timer will seal.
      armFlushTimer()
    } catch {
      // Logging must never break its caller (spec §3.9).
    }
  }

  async function flush(): Promise<void> {
    // Another waiting flush may start the next batch before this waiter resumes.
    // Recheck until that batch also completes before acknowledging an exit/export.
    while (inFlight) await inFlight
    sealPending()
    if (omitted > 0) {
      queue.push({ level: "warn", target: "logger", message: `${omitted} log records omitted (queue full)` })
      omitted = 0
    }
    if (queue.length === 0) return
    clearFlushTimer()
    const batch = queue.splice(0, queue.length)
    if (mirror) {
      // A patched or mocked `console.*` must not make `flush()` reject.
      for (const record of batch) {
        try {
          mirrorRecord(record)
        } catch {
          // Mirroring is best-effort; the record is already in the batch.
        }
      }
    }
    // The async wrapper catches a synchronous throw from `send` as well as a
    // rejection, so `flush()` can never reject.
    inFlight = (async () => {
      await deps.send(batch)
    })()
      .catch(() => {
        // A lost batch must never reach the caller. Count it as drops so a dead
        // IPC trips the breaker instead of being hammered every flush — but a
        // bypassed `error` is the green channel and must never count, or 1000
        // queued fatal records would silence logging for the whole cooldown.
        // The suppression `warn` is the one record counted here that never
        // consumed a token (it is queued directly, not through `emit`); that is
        // unavoidable under this mechanism.
        noteDrops(batch.filter(record => record.level !== LOG_ALWAYS_PASS_LEVEL).length)
      })
      .finally(() => {
        inFlight = null
        if (pending || queue.length > 0 || omitted > 0) armFlushTimer()
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

function boundedText(text: string, limit: number): string {
  const suffix = "… [truncated]"
  return text.length <= limit ? text : truncateText(text, limit - suffix.length) + suffix
}

function truncateText(text: string, limit: number): string {
  const truncated = text.slice(0, limit)
  // A split surrogate pair would make the JSON string invalid for Rust's UTF-8 sink.
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated
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
