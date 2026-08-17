import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultServices } from "../src/desktopServices"

const check = vi.fn()

vi.mock("@tauri-apps/plugin-updater", () => ({
  check,
}))

describe("checkForUpdates", () => {
  beforeEach(() => {
    check.mockReset()
  })

  it("resolves null when no update is available", async () => {
    check.mockResolvedValue(null)
    await expect(defaultServices.checkForUpdates!()).resolves.toBeNull()
  })

  it("returns version and currentVersion when an update is available", async () => {
    check.mockResolvedValue({ version: "0.2.0", currentVersion: "0.1.0" })
    await expect(defaultServices.checkForUpdates!()).resolves.toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
    })
  })

  it("resolves null when the update check throws", async () => {
    check.mockRejectedValue(new Error("no network"))
    await expect(defaultServices.checkForUpdates!()).resolves.toBeNull()
  })
})
