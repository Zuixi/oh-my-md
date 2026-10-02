import { describe, expect, it, vi } from "vitest"
import {
  createLogger,
  getGlobalLogger,
  setGlobalLogger,
  type LogRecord,
  type Logger,
} from "../src/logger"
import {
  LOG_BREAKER_COOLDOWN_MS,
  LOG_BREAKER_DROPS,
  LOG_BREAKER_WINDOW_MS,
  LOG_RATE_LIMIT_PER_SEC,
} from "../src/constants"

interface Harness {
  logger: Logger
  batches: LogRecord[][]
  sent: () => LogRecord[]
  now: { t: number }
}

/** Time and the transport are injected, so every layer-2/3 boundary is reached
 *  deterministically instead of by sleeping. `mirrorToConsole: false` keeps the
 *  suite output pristine (Vitest defines `import.meta.env.DEV`). */
function harness(): Harness {
  const now = { t: 0 }
  const batches: LogRecord[][] = []
  const logger = createLogger({
    now: () => now.t,
    mirrorToConsole: false,
    send: async records => {
      batches.push(records)
    },
  })
  return { logger, batches, sent: () => batches.flat(), now }
}

/** One window's allowance of accepted records, then enough distinct records to
 *  reach the breaker threshold through rate-limit drops. */
function tripBreaker(h: Harness): void {
  for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC + LOG_BREAKER_DROPS + 5; i += 1) {
    h.logger.debug("tick", `d-${i}`)
  }
}

describe("logger facade", () => {
  it("collapses consecutive identical records into a repeat count", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < 5; i += 1) logger.warn("save", "retrying")
    await logger.flush()
    const records = sent().filter(r => r.message.startsWith("retrying"))
    expect(records).toHaveLength(1)
    expect(records[0].message).toContain("repeated 5 times")
  })

  it("only collapses consecutive identical records", async () => {
    const { logger, sent } = harness()
    logger.warn("save", "a")
    logger.warn("save", "b")
    logger.warn("save", "a")
    await logger.flush()
    expect(sent().filter(r => r.message === "a")).toHaveLength(2)
  })

  it("caps the offered rate at LOG_RATE_LIMIT_PER_SEC", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC * 3; i += 1) {
      logger.debug("tick", `distinct-${i}`)
    }
    await logger.flush()
    expect(sent().filter(r => r.message.startsWith("distinct-"))).toHaveLength(
      LOG_RATE_LIMIT_PER_SEC,
    )
  })

  it("refills the bucket in the next one-second window", async () => {
    const { logger, sent, now } = harness()
    for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC; i += 1) logger.debug("tick", `first-${i}`)
    now.t += 1000
    for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC; i += 1) logger.debug("tick", `second-${i}`)
    await logger.flush()
    expect(sent().filter(r => r.message.startsWith("first-"))).toHaveLength(LOG_RATE_LIMIT_PER_SEC)
    expect(sent().filter(r => r.message.startsWith("second-"))).toHaveLength(LOG_RATE_LIMIT_PER_SEC)
  })

  it("offers error records even when the rate limit is exhausted", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC * 2; i += 1) logger.debug("tick", `d-${i}`)
    logger.error("boot", "fatal")
    await logger.flush()
    expect(sent().some(r => r.level === "error" && r.message === "fatal")).toBe(true)
  })

  it("delivers error records while the breaker is open", async () => {
    const h = harness()
    tripBreaker(h)
    h.logger.error("boot", "fatal")
    await h.logger.flush()
    expect(h.sent().some(r => r.message === "fatal")).toBe(true)
  })

  it("drops non-error records while the breaker is open", async () => {
    const h = harness()
    tripBreaker(h)
    h.now.t = 100
    h.logger.warn("noisy", "silenced")
    await h.logger.flush()
    expect(h.sent().some(r => r.message === "silenced")).toBe(false)
  })

  it("emits exactly one suppression summary per trip, not one per rejected record", async () => {
    const h = harness()
    tripBreaker(h)
    for (let i = 0; i < 500; i += 1) h.logger.debug("tick", `late-${i}`)
    await h.logger.flush()
    const summaries = h.sent().filter(r => r.message.includes("logging suppressed"))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      level: "warn",
      target: "logger",
      message: `logging suppressed for ${LOG_BREAKER_COOLDOWN_MS}ms after ${LOG_BREAKER_DROPS} drops`,
    })
  })

  it("still collapses repeated identical errors while the breaker is open", async () => {
    const h = harness()
    tripBreaker(h)
    for (let i = 0; i < 4; i += 1) h.logger.error("boot", "same failure")
    await h.logger.flush()
    const errors = h.sent().filter(r => r.level === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("same failure")
    expect(errors[0].message).toContain("repeated 4 times")
  })

  it("does not let bypassed errors extend the breaker", async () => {
    const h = harness()
    tripBreaker(h)
    h.now.t = 1000
    for (let i = 0; i < LOG_BREAKER_DROPS + 10; i += 1) h.logger.error("boom", `e-${i}`)
    h.now.t = LOG_BREAKER_COOLDOWN_MS + 1
    h.logger.info("back", "resumed")
    await h.logger.flush()
    expect(h.sent().some(r => r.message === "resumed")).toBe(true)
  })

  it("reopens after the cooldown elapses", async () => {
    const h = harness()
    tripBreaker(h)
    h.now.t = LOG_BREAKER_COOLDOWN_MS + LOG_BREAKER_WINDOW_MS + 1
    h.logger.info("back", "resumed")
    await h.logger.flush()
    expect(h.sent().some(r => r.message === "resumed")).toBe(true)
  })

  it("never throws when the transport rejects", async () => {
    const logger = createLogger({
      now: () => 0,
      mirrorToConsole: false,
      send: async () => {
        throw new Error("ipc down")
      },
    })
    expect(() => logger.error("x", "y")).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()
  })

  it("never rejects when the transport throws synchronously", async () => {
    const logger = createLogger({
      now: () => 0,
      mirrorToConsole: false,
      send: () => {
        throw new Error("no ipc")
      },
    })
    expect(() => logger.info("x", "y")).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()
  })

  it("counts a rejected batch toward the breaker instead of hammering a dead IPC", async () => {
    const now = { t: 0 }
    const batches: LogRecord[][] = []
    const logger = createLogger({
      now: () => now.t,
      mirrorToConsole: false,
      send: async records => {
        batches.push(records)
        throw new Error("ipc down")
      },
    })
    // Queue one window's allowance per second without flushing, so the single
    // rejected flush carries the whole breaker budget.
    const rounds = LOG_BREAKER_DROPS / LOG_RATE_LIMIT_PER_SEC
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC; i += 1) logger.debug("tick", `r${round}-${i}`)
      now.t += 1000
    }
    await logger.flush()
    logger.info("late", "after the failed batch")
    await logger.flush()
    expect(batches.flat().some(r => r.message === "after the failed batch")).toBe(false)
  })

  it("does not send an empty batch", async () => {
    const { logger, batches } = harness()
    await logger.flush()
    expect(batches).toHaveLength(0)
  })

  it("delivers everything queued, in order, across flushes", async () => {
    const h = harness()
    h.logger.info("a", "one")
    await h.logger.flush()
    h.logger.info("b", "two")
    await h.logger.flush()
    expect(h.batches).toHaveLength(2)
    expect(h.sent().map(r => r.message)).toEqual(["one", "two"])
  })

  it("mirrors to the console only when the dev flag is set", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    try {
      const quiet = createLogger({ now: () => 0, mirrorToConsole: false, send: async () => {} })
      quiet.error("boot", "quiet")
      quiet.trace("boot", "quiet trace")
      await quiet.flush()
      expect(error).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()

      const loud = createLogger({ now: () => 0, mirrorToConsole: true, send: async () => {} })
      loud.error("boot", "loud")
      loud.trace("boot", "loud trace")
      await loud.flush()
      expect(error).toHaveBeenCalledWith("[boot] loud")
      // Devtools has no trace channel; trace mirrors on debug.
      expect(debug).toHaveBeenCalledWith("[boot] loud trace")
    } finally {
      error.mockRestore()
      debug.mockRestore()
    }
  })
})

describe("global logger", () => {
  it("creates a usable default logger when none was installed", async () => {
    const logger = getGlobalLogger()
    expect(getGlobalLogger()).toBe(logger)
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.flush).toBe("function")
    await expect(logger.flush()).resolves.toBeUndefined()
  })

  it("returns the logger installed by setGlobalLogger", () => {
    const installed: Logger = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      flush: async () => {},
    }
    setGlobalLogger(installed)
    expect(getGlobalLogger()).toBe(installed)
  })
})
