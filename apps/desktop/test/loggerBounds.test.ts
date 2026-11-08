import { describe, expect, it } from "vitest"
import { createLogger, type LogRecord } from "../src/logger"
import { LOG_MAX_BATCH_RECORDS, LOG_MAX_MESSAGE_CHARS, LOG_MAX_TARGET_CHARS } from "../src/constants"

const options = { now: () => 0, mirrorToConsole: false, scheduleFlush: () => {} }

describe("bounded logging during failure", () => {
  it("bounds distinct fatal errors and reports omitted records", async () => {
    const batches: LogRecord[][] = []
    const logger = createLogger({ ...options, send: async batch => { batches.push(batch) } })
    for (let i = 0; i < LOG_MAX_BATCH_RECORDS * 5; i++) logger.error("fatal", `failure ${i}`)
    await logger.flush()
    expect(batches.flat().length).toBeLessThanOrEqual(LOG_MAX_BATCH_RECORDS)
    expect(batches.flat().some(record => record.message.includes("omitted"))).toBe(true)
    expect(batches.flat().some(record => record.message === "failure 999")).toBe(true)
  })

  it("caps individual payloads before IPC and keeps a fatal after ordinary traffic", async () => {
    const records: LogRecord[] = []
    const logger = createLogger({ ...options, send: async batch => { records.push(...batch) } })
    for (let i = 0; i < 100; i++) logger.warn("poll", `warning ${i}`)
    logger.error("x".repeat(LOG_MAX_TARGET_CHARS * 2), "x".repeat(LOG_MAX_MESSAGE_CHARS * 2))
    await logger.flush()
    const fatal = records.find(record => record.level === "error")!
    expect(fatal.target.length).toBeLessThanOrEqual(LOG_MAX_TARGET_CHARS)
    expect(fatal.message.length).toBeLessThanOrEqual(LOG_MAX_MESSAGE_CHARS)
    expect(fatal.message).toContain("truncated")
  })

  it("keeps truncated Unicode messages and targets valid for JSON IPC", async () => {
    const records: LogRecord[] = []
    const logger = createLogger({ ...options, send: async batch => { records.push(...batch) } })
    logger.error("x".repeat(LOG_MAX_TARGET_CHARS - 1) + "😀", "😀".repeat(LOG_MAX_MESSAGE_CHARS))
    await logger.flush()
    for (const text of [records[0].target, records[0].message]) {
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })

  it("keeps a blocked transport to one in-flight batch and a bounded pending batch", async () => {
    let complete!: () => void
    const gate = new Promise<void>(resolve => { complete = resolve })
    const batches: LogRecord[][] = []
    const logger = createLogger({ ...options, send: async batch => { batches.push(batch); await gate } })
    logger.error("fatal", "first")
    const first = logger.flush()
    for (let i = 0; i < LOG_MAX_BATCH_RECORDS * 5; i++) logger.error("fatal", `blocked ${i}`)
    const second = logger.flush()
    expect(batches).toHaveLength(1)
    complete()
    await Promise.all([first, second])
    expect(batches).toHaveLength(2)
    expect(batches[1].length).toBeLessThanOrEqual(LOG_MAX_BATCH_RECORDS)
  })
})
