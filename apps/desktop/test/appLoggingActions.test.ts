import { describe, expect, it, vi } from "vitest"
import { restartToApplyLogging } from "../src/appLoggingActions"
import type { DesktopServices } from "../src/desktopServices"
import { initLocale } from "../src/i18n"
import { trackSettingsSave } from "../src/settingsPersistence"
import { DEFAULT_SETTINGS } from "../src/settings"

initLocale("en")

function services(overrides: Partial<DesktopServices>): DesktopServices {
  return {
    reportError: vi.fn(),
    confirmRestartForLogging: vi.fn(() => true),
    prepareUpdateRestart: vi.fn(async () => ({ kind: "ready" as const })),
    restartApp: vi.fn(async () => undefined),
    ...overrides,
  } as DesktopServices
}

describe("restartToApplyLogging", () => {
  it("flushes first, then restarts", async () => {
    const prepareUpdateRestart = vi.fn(async () => ({ kind: "ready" as const }))
    const restartApp = vi.fn(async () => undefined)
    await restartToApplyLogging(services({ prepareUpdateRestart, restartApp }))
    expect(prepareUpdateRestart).toHaveBeenCalledOnce()
    expect(restartApp).toHaveBeenCalledOnce()
  })

  it("does nothing when the user cancels", async () => {
    const prepareUpdateRestart = vi.fn()
    const restartApp = vi.fn()
    await restartToApplyLogging(services({
      confirmRestartForLogging: () => false,
      prepareUpdateRestart,
      restartApp,
    }))
    expect(prepareUpdateRestart).not.toHaveBeenCalled()
    expect(restartApp).not.toHaveBeenCalled()
  })

  // A hung webview must never restart the app under the user: a timed-out flush
  // aborts the restart and says why, exactly like the update path.
  it("aborts the restart when the flush times out", async () => {
    const reportError = vi.fn()
    const restartApp = vi.fn()
    await restartToApplyLogging(services({
      reportError,
      prepareUpdateRestart: vi.fn(async () => ({ kind: "timedOut" as const })),
      restartApp,
    }))
    expect(restartApp).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "oh-my-md did not finish saving session state in time, so the update was not installed. Your documents are safe.",
    )
  })

  it("reports a rejected restart instead of leaving it unhandled", async () => {
    const reportError = vi.fn()
    await restartToApplyLogging(services({
      reportError,
      restartApp: vi.fn(async () => { throw new Error("ipc down") }),
    }))
    expect(reportError).toHaveBeenCalledExactlyOnceWith("Restart failed: ipc down")
  })
})

// The restart replaces the process, and the new one reads `settings.json`. A save
// still in flight — or one that silently fell back to localStorage — would make
// the restart look successful while the preference never reached the file, i.e.
// the toggle would appear applied and do nothing.
describe("settings must reach disk before the restart", () => {
  it("serializes consecutive settings writes before restart", async () => {
    let releaseFirst: (value: boolean) => void = () => undefined
    const first = new Promise<boolean>(resolve => { releaseFirst = resolve })
    const writes: number[] = []
    const saveSettings = vi.fn((settings: typeof DEFAULT_SETTINGS) => {
      writes.push(settings.loggingGeneration)
      return writes.length === 1 ? first : Promise.resolve(true)
    })
    const slot = { current: Promise.resolve(true) }
    trackSettingsSave(slot, { saveSettings }, { ...DEFAULT_SETTINGS, loggingGeneration: 1 })
    trackSettingsSave(slot, { saveSettings }, { ...DEFAULT_SETTINGS, loggingGeneration: 2 })
    await Promise.resolve()
    expect(writes).toEqual([1])
    releaseFirst(true)
    await slot.current
    expect(writes).toEqual([1, 2])
  })
  it("waits for the in-flight settings save", async () => {
    const order: string[] = []
    await restartToApplyLogging(
      services({
        prepareUpdateRestart: vi.fn(async () => { order.push("flush") ; return { kind: "ready" as const } }),
        restartApp: vi.fn(async () => { order.push("restart") }),
      }),
      async () => { order.push("settings-saved"); return true },
    )
    expect(order).toEqual(["settings-saved", "flush", "restart"])
  })

  it("does not restart when the save only reached the local fallback", async () => {
    const reportError = vi.fn()
    const prepareUpdateRestart = vi.fn()
    const restartApp = vi.fn()
    await restartToApplyLogging(
      services({ reportError, prepareUpdateRestart, restartApp }),
      async () => false,
    )
    expect(prepareUpdateRestart).not.toHaveBeenCalled()
    expect(restartApp).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "The logging setting could not be saved to disk, so oh-my-md was not restarted.",
    )
  })

  it("does not even ask for a restart when the user cancels", async () => {
    const awaitSettings = vi.fn(async () => true)
    await restartToApplyLogging(services({ confirmRestartForLogging: () => false }), awaitSettings)
    expect(awaitSettings).not.toHaveBeenCalled()
  })
})
