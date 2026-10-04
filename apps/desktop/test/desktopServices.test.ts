import { afterEach, describe, expect, it, vi } from "vitest"
import { toDocumentCommandError } from "../src/desktopServices"
import type { LogRecord } from "../src/logger"

const { invoke, revealItemInDir, toast, save } = vi.hoisted(() => ({
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  save: vi.fn(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save }))
vi.mock("react-toastify", () => ({ toast }))

import { defaultServices } from "../src/desktopServices"

describe("desktop document IPC", () => {
  it("normalizes a typed rust rejection", () => {
    expect(toDocumentCommandError({ code: "permissionDenied", message: "cannot write" }))
      .toEqual({ code: "permissionDenied", message: "cannot write" })
  })

  it("falls back to internal for unknown rejections", () => {
    expect(toDocumentCommandError(new Error("boom")))
      .toEqual({ code: "internal", message: "boom" })
    expect(toDocumentCommandError({ code: "notARealCode" }).code).toBe("internal")
  })
})

describe("setMenuLocale", () => {
  it("invokes set_menu_locale with locale", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await defaultServices.setMenuLocale?.("zh")
    expect(invoke).toHaveBeenCalledWith("set_menu_locale", { locale: "zh" })
  })
})

describe("listSystemFonts", () => {
  it("invokes list_system_fonts with no arguments", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce(["Arial", "Menlo"])
    await expect(defaultServices.listSystemFonts?.()).resolves.toEqual(["Arial", "Menlo"])
    expect(invoke).toHaveBeenCalledWith("list_system_fonts")
  })

  it("resolves null when the invoke rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("font enumeration failed"))
    await expect(defaultServices.listSystemFonts?.()).resolves.toBeNull()
  })
})

describe("revealInFinder", () => {
  it("delegates to the official plugin-opener binding with the path", async () => {
    revealItemInDir.mockResolvedValueOnce(undefined)
    invoke.mockClear()
    await defaultServices.revealInFinder?.("/tmp/notes.md")
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/notes.md")
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("logRecords", () => {
  it("invokes log_frontend with the record batch", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce(undefined)
    const records: LogRecord[] = [{ level: "warn", target: "save", message: "retrying" }]
    await defaultServices.logRecords?.(records)
    expect(invoke).toHaveBeenCalledWith("log_frontend", { records })
  })
})

describe("export diagnostics", () => {
  /** Answers the notice and then the full-paths opt-in, in that order. */
  function confirmTwice(notice: boolean, includeFullPaths: boolean) {
    const confirm = vi.spyOn(window, "confirm")
    confirm.mockReturnValueOnce(notice).mockReturnValueOnce(includeFullPaths)
    return confirm
  }

  afterEach(() => {
    vi.restoreAllMocks()
    invoke.mockClear()
    save.mockReset()
  })

  it("asks before exporting and maps the opt-in to the command argument", async () => {
    save.mockResolvedValueOnce("/tmp/omd.zip")
    invoke.mockResolvedValueOnce(undefined)
    const confirm = confirmTwice(true, false)

    await defaultServices.exportDiagnostics?.()

    // Two questions: what will be included, then the full-paths opt-in. The
    // first must name the contents, so it cannot be a bare "are you sure".
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[0][0]).toMatch(/diagnostics/i)
    expect(confirm.mock.calls[0][0]).toMatch(/log/i)
    expect(invoke).toHaveBeenCalledWith("export_diagnostics", {
      path: "/tmp/omd.zip",
      includeFullPaths: false,
    })
  })

  it("includes full file paths only after the opt-in", async () => {
    save.mockResolvedValueOnce("/tmp/omd.zip")
    invoke.mockResolvedValueOnce(undefined)
    confirmTwice(true, true)

    await defaultServices.exportDiagnostics?.()

    expect(invoke).toHaveBeenCalledWith("export_diagnostics", {
      path: "/tmp/omd.zip",
      includeFullPaths: true,
    })
  })

  it("exports nothing when the notice is declined", async () => {
    confirmTwice(false, true)

    await defaultServices.exportDiagnostics?.()

    // No destination is chosen and nothing is invoked: a declined notice must
    // not leave the user holding a save dialog.
    expect(save).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("exports nothing when the save dialog is cancelled", async () => {
    save.mockResolvedValueOnce(null)
    confirmTwice(true, false)

    await defaultServices.exportDiagnostics?.()

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("toast notifications", () => {
  it("reports errors through toast.error with the 8s autoClose", () => {
    defaultServices.reportError("Save failed: disk full")
    expect(toast.error).toHaveBeenCalledWith(
      "Save failed: disk full",
      { autoClose: 8000 },
    )
  })

  it("notifies success through toast.success with the 3s autoClose", () => {
    defaultServices.notifySuccess?.("Created notes.md")
    expect(toast.success).toHaveBeenCalledWith(
      "Created notes.md",
      { autoClose: 3000 },
    )
  })
})

describe("update capability (automatic updates)", () => {
  it("invokes update_capability and returns the platform capability", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ check: true, install: true })
    await expect(defaultServices.updateCapability?.()).resolves.toEqual({
      check: true,
      install: true,
    })
    expect(invoke).toHaveBeenCalledWith("update_capability")
  })

  it("returns a check-only capability for manual-install platforms", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ check: true, install: false, reason: "manualPackage" })
    await expect(defaultServices.updateCapability?.()).resolves.toEqual({
      check: true,
      install: false,
      reason: "manualPackage",
    })
  })
})

describe("prepare update restart (automatic updates)", () => {
  it("invokes prepare_update_restart and returns a ready flush outcome", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ kind: "ready" })
    await expect(defaultServices.prepareUpdateRestart?.()).resolves.toEqual({ kind: "ready" })
    expect(invoke).toHaveBeenCalledWith("prepare_update_restart")
  })

  it("surfaces a timedOut session-flush outcome", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ kind: "timedOut" })
    await expect(defaultServices.prepareUpdateRestart?.()).resolves.toEqual({ kind: "timedOut" })
  })
})
