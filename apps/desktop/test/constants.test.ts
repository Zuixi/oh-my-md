import { describe, expect, it } from "vitest"
import { RELEASES_URL, windowsSetupAssetUrl } from "../src/constants"

/**
 * The updater deep-links check-only installs (former MSI, deb/rpm) straight to
 * the NSIS setup asset. The release workflow pins the same asset name (it
 * fails when `oh-my-md_${version}_x64-setup.exe` is missing), and
 * scripts/update-manifest.mjs builds URLs of the same shape — this test pins
 * the frontend side of that contract.
 */
describe("windowsSetupAssetUrl", () => {
  it("builds the versioned x64 setup URL by default", () => {
    expect(windowsSetupAssetUrl("0.2.0")).toBe(
      "https://github.com/Zuixi/oh-my-md/releases/download/v0.2.0/oh-my-md_0.2.0_x64-setup.exe",
    )
  })

  it("substitutes the architecture segment", () => {
    expect(windowsSetupAssetUrl("0.2.0", "arm64")).toBe(
      "https://github.com/Zuixi/oh-my-md/releases/download/v0.2.0/oh-my-md_0.2.0_arm64-setup.exe",
    )
  })

  it("stays under the releases download path with no nested segments", () => {
    const url = new URL(windowsSetupAssetUrl("1.0.0"))
    expect(url.origin).toBe("https://github.com")
    expect(url.pathname.startsWith("/Zuixi/oh-my-md/releases/download/v1.0.0/")).toBe(true)
    // The manifest validator rejects URLs with extra path segments after the tag.
    expect(url.pathname.endsWith("/oh-my-md_1.0.0_x64-setup.exe")).toBe(true)
  })

  it("does not collide with the generic releases page constant", () => {
    expect(windowsSetupAssetUrl("0.2.0")).not.toBe(RELEASES_URL)
    expect(RELEASES_URL.endsWith("/releases/latest")).toBe(true)
  })
})
