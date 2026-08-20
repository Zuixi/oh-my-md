import { describe, expect, it, vi } from "vitest"
import { toDocumentCommandError } from "../src/desktopServices"

const { invoke, revealItemInDir, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }))
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
