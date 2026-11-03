import { describe, expect, it, vi } from "vitest"
import { exportDiagnostics, openLogFolder } from "../src/appDiagnosticsActions"
import type { DesktopServices } from "../src/desktopServices"
import { initLocale } from "../src/i18n"
import { createLogger, getGlobalLogger, setGlobalLogger } from "../src/logger"

function services(overrides: Partial<DesktopServices>): DesktopServices {
  return { reportError: vi.fn(), ...overrides } as DesktopServices
}

describe("diagnostics commands", () => {
  initLocale("en")

  it("reports a failed export instead of swallowing it", async () => {
    const reportError = vi.fn()
    await exportDiagnostics(services({
      exportDiagnostics: vi.fn().mockRejectedValue(new Error("disk full")),
      reportError,
    }))
    expect(reportError).toHaveBeenCalledExactlyOnceWith("Diagnostics export failed: disk full")
  })

  it("stays silent when the export succeeds", async () => {
    const reportError = vi.fn()
    await exportDiagnostics(services({
      exportDiagnostics: vi.fn().mockResolvedValue(undefined),
      reportError,
    }))
    expect(reportError).not.toHaveBeenCalled()
  })

  it("reports a refused log-folder open (logging off has no folder)", async () => {
    const reportError = vi.fn()
    await openLogFolder(services({
      openLogDir: vi.fn().mockRejectedValue(new Error("logging is turned off in Settings")),
      reportError,
    }))
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "Could not open the log folder: logging is turned off in Settings",
    )
  })
})

// The bundle must contain what just happened, so the export use case flushes the
// queue before invoking. That step moved out of the IPC layer, which now only
// resolves a destination and invokes.
describe("export ordering", () => {
  it("flushes queued records before the bundle is requested", async () => {
    const previous = getGlobalLogger()
    const order: string[] = []
    const logger = createLogger({
      now: () => 0,
      mirrorToConsole: false,
      scheduleFlush: () => {},
      send: async () => { order.push("flushed") },
    })
    setGlobalLogger(logger)
    // An empty queue sends nothing (by design), so queue the record this test
    // is about: the export must not overtake it.
    logger.warn("ui", "the failure the bundle must contain")
    try {
      await exportDiagnostics(services({
        exportDiagnostics: vi.fn(async () => { order.push("exported") }),
        reportError: vi.fn(),
      }))
      expect(order).toEqual(["flushed", "exported"])
    } finally {
      setGlobalLogger(previous)
    }
  })
})
