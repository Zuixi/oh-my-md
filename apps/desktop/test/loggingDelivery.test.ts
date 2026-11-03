import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger, getGlobalLogger, setGlobalLogger, type LogRecord } from "../src/logger"

const { invoke, save } = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save }))
import { defaultServices } from "../src/desktopServices"
import { exportDiagnostics as exportBundle } from "../src/appDiagnosticsActions"
import { reportFatal } from "../src/globalErrorHandlers"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("logging delivery ordering", () => {
  it("coalesces immediate flush requests during an uncaught-error storm", async () => {
    const gate = deferred()
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), flush: vi.fn(() => gate.promise) }
    for (let index = 0; index < 100; index++) reportFatal(logger, "window", `fatal ${index}`)
    expect(logger.error).toHaveBeenCalledTimes(100)
    expect(logger.flush).toHaveBeenCalledTimes(1)
    gate.resolve()
    for (let tick = 0; tick < 5; tick++) await Promise.resolve()
    reportFatal(logger, "window", "later fatal")
    expect(logger.flush).toHaveBeenCalledTimes(2)
  })

  it("does not repeatedly schedule flush waiters behind a blocked transport", async () => {
    const gate = deferred()
    const timers: (() => void)[] = []
    const logger = createLogger({ now: () => 0, mirrorToConsole: false, scheduleFlush: run => { timers.push(run) }, send: async () => { await gate.promise } })
    logger.error("audit", "first")
    timers.shift()?.()
    try {
      for (let index = 0; index < 20; index++) {
        logger.error("audit", `pending ${index}`)
        expect(timers).toHaveLength(0)
      }
    } finally {
      gate.resolve()
      await logger.flush()
    }
  })
  it("does not acknowledge a concurrent exit flush while the next batch is still in flight", async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const batches: LogRecord[][] = []
    const logger = createLogger({ now: () => 0, mirrorToConsole: false, scheduleFlush: () => {}, send: async records => {
      batches.push(records)
      await (batches.length === 1 ? firstGate.promise : secondGate.promise)
    } })
    logger.error("audit", "batch one")
    const first = logger.flush()
    logger.error("audit", "batch two")
    const timerFlush = logger.flush()
    let acked = false
    const exitFlush = logger.flush().then(() => { acked = true })
    let ackedBeforeSecondDelivery = false
    try {
      firstGate.resolve()
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      expect(batches).toHaveLength(2)
      ackedBeforeSecondDelivery = acked
    } finally {
      firstGate.resolve()
      secondGate.resolve()
      await Promise.all([first, timerFlush, exitFlush])
    }
    expect(ackedBeforeSecondDelivery).toBe(false)
  })

  it("still exports diagnostics when log delivery is stuck", async () => {
    vi.useFakeTimers()
    const previous = getGlobalLogger()
    const gate = deferred()
    const send = vi.fn(async () => { await gate.promise })
    const logger = createLogger({ now: () => 0, mirrorToConsole: false, scheduleFlush: () => {}, send })
    setGlobalLogger(logger)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    save.mockResolvedValue("/tmp/omd-audit.zip")
    invoke.mockResolvedValue(undefined)
    try {
      logger.warn("ui", "pending failure")
      const exporting = exportBundle(defaultServices)
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(invoke).not.toHaveBeenCalled()
      await vi.runAllTimersAsync()
      await exporting
      expect(invoke).toHaveBeenCalledWith("export_diagnostics", { path: "/tmp/omd-audit.zip", includeFullPaths: false })
    } finally {
      gate.resolve()
      await logger.flush()
      setGlobalLogger(previous)
    }
  })

  it("delivers queued errors before the diagnostics exporter reads the log", async () => {
    const previous = getGlobalLogger()
    const order: string[] = []
    const logger = createLogger({ now: () => 0, mirrorToConsole: false, scheduleFlush: () => {}, send: async () => { order.push("log delivered") } })
    setGlobalLogger(logger)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    save.mockResolvedValue("/tmp/omd-audit.zip")
    invoke.mockImplementation(async (command: string) => { order.push(command) })
    try {
      logger.warn("ui", "the error the support bundle must contain")
      await exportBundle(defaultServices)
      expect(order).toEqual(["log delivered", "export_diagnostics"])
    } finally {
      await logger.flush()
      setGlobalLogger(previous)
    }
  })
})
