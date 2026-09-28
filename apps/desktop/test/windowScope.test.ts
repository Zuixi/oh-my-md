import { describe, expect, it, vi } from "vitest"

describe("windowScope", () => {
  it("defaults to main outside Tauri", async () => {
    vi.resetModules()
    const { currentWindowLabel, isMainWindow } = await import("../src/windowScope")
    expect(currentWindowLabel()).toBe("main")
    expect(isMainWindow()).toBe(true)
  })
})
