import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as unknown
}

function resolveTauriAsset(relativePath: string): string {
  return resolve(process.cwd(), "src-tauri", relativePath)
}

function bmpDimensions(relativePath: string): { width: number; height: number } {
  const buf = readFileSync(resolveTauriAsset(relativePath))
  return {
    width: buf.readInt32LE(18),
    height: Math.abs(buf.readInt32LE(22)),
  }
}

describe("Tauri frontend security configuration", () => {
  it("grants only the dialog operations used by the desktop UI", () => {
    const capability = readJson("../src-tauri/capabilities/default.json") as {
      permissions: string[]
    }

    expect(capability.permissions).toContain("dialog:allow-open")
    expect(capability.permissions).toContain("dialog:allow-save")
    expect(capability.permissions).not.toContain("dialog:default")
  })

  it("enables a CSP that limits scripts and local image loading", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      app: { security: { csp: string | null } }
    }
    const csp = config.app.security.csp

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("img-src 'self' asset: http://asset.localhost data: https:")
    expect(csp).toContain("connect-src ipc: http://ipc.localhost ws:")
  })

  it("does not grant a permanent wildcard asset protocol scope", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      app: {
        security: { assetProtocol: { enable: boolean; scope: string[] } }
      }
    }

    expect(config.app.security.assetProtocol.enable).toBe(true)
    expect(config.app.security.assetProtocol.scope).toEqual([])
  })
})

describe("Windows installer branding assets", () => {
  it("uses NSIS sidebar and WiX bitmaps at the required aspect ratios", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      bundle: {
        windows: {
          nsis: { headerImage?: string; sidebarImage: string }
          wix: { bannerPath: string; dialogImagePath: string }
        }
      }
    }
    const nsis = config.bundle.windows.nsis
    const wix = config.bundle.windows.wix

    expect(nsis.headerImage).toBeUndefined()

    for (const relativePath of [
      nsis.sidebarImage,
      wix.bannerPath,
      wix.dialogImagePath,
    ]) {
      expect(existsSync(resolveTauriAsset(relativePath))).toBe(true)
    }

    expect(bmpDimensions(nsis.sidebarImage)).toEqual({ width: 164, height: 314 })
    expect(bmpDimensions(wix.bannerPath)).toEqual({ width: 493, height: 58 })
    expect(bmpDimensions(wix.dialogImagePath)).toEqual({ width: 493, height: 312 })
  })

  it("wires NSIS copy hooks and SimpChinese language file", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      bundle: {
        windows: {
          nsis: {
            installerHooks: string
            customLanguageFiles: Record<string, string>
          }
        }
      }
    }
    const nsis = config.bundle.windows.nsis

    expect(existsSync(resolveTauriAsset(nsis.installerHooks))).toBe(true)
    expect(nsis.customLanguageFiles.SimpChinese).toBe(
      "windows/nsis-languages/SimpChinese.nsh",
    )
    expect(existsSync(resolveTauriAsset(nsis.customLanguageFiles.SimpChinese))).toBe(true)
  })
})
