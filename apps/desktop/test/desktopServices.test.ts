import { describe, expect, it, vi } from "vitest"
import { toDocumentCommandError } from "../src/desktopServices"

const { invoke, revealItemInDir } = vi.hoisted(() => ({
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }))

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

describe("revealInFinder", () => {
  it("delegates to the official plugin-opener binding with the path", async () => {
    revealItemInDir.mockResolvedValueOnce(undefined)
    invoke.mockClear()
    await defaultServices.revealInFinder?.("/tmp/notes.md")
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/notes.md")
    expect(invoke).not.toHaveBeenCalled()
  })
})
