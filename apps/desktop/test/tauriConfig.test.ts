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

// WixUI draws transparent page titles over this strip of the WiX banner.
// Keep in sync with WIX_BANNER_TITLE_SAFE_W / BANNER_BG in
// scripts/generate_installer_images.py.
const WIX_BANNER_TITLE_SAFE_W = 220
const WIX_BANNER_BG: [number, number, number] = [243, 244, 246]

function bmpDimensions(relativePath: string): { width: number; height: number } {
  const buf = readFileSync(resolveTauriAsset(relativePath))
  return {
    width: buf.readInt32LE(18),
    height: Math.abs(buf.readInt32LE(22)),
  }
}

function readBmpPixels(relativePath: string): {
  width: number
  height: number
  pixelAt: (x: number, y: number) => [number, number, number]
} {
  const buf = readFileSync(resolveTauriAsset(relativePath))
  const pixelDataOffset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const height = buf.readInt32LE(22)
  if (buf.readUInt16LE(28) !== 24 || buf.readUInt32LE(30) !== 0 || height < 0) {
    throw new Error(`expected an uncompressed bottom-up 24-bit BMP: ${relativePath}`)
  }
  const stride = Math.floor((24 * width + 31) / 32) * 4
  return {
    width,
    height,
    pixelAt: (x, y) => {
      const offset = pixelDataOffset + (height - 1 - y) * stride + x * 3
      // BMP rows are B,G,R; return RGB.
      return [buf[offset + 2]!, buf[offset + 1]!, buf[offset]!]
    },
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

  it("does not configure updater behavior or build updater artifacts", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      bundle: { createUpdaterArtifacts?: boolean }
      plugins?: Record<string, unknown>
    }
    const capability = readJson("../src-tauri/capabilities/default.json") as {
      permissions: string[]
    }

    expect(config.plugins?.updater).toBeUndefined()
    expect(config.bundle.createUpdaterArtifacts).toBeUndefined()
    expect(capability.permissions).not.toContain("updater:default")
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

  it("keeps the WiX banner title strip clean for WixUI's overlaid page titles", () => {
    const config = readJson("../src-tauri/tauri.conf.json") as {
      bundle: { windows: { wix: { bannerPath: string } } }
    }
    const bmp = readBmpPixels(config.bundle.windows.wix.bannerPath)
    expect(bmp.width).toBe(493)
    expect(bmp.height).toBe(58)

    // WixUI paints a transparent black page title ("Installing oh-my-md", …)
    // over X=15..215 dialog units of the banner on every inner page, at any
    // DPI. Anything baked into that strip collides with the title text and
    // renders as overlapping glyphs (see known-gotchas installer section).
    // Must stay in sync with WIX_BANNER_TITLE_SAFE_W / BANNER_BG in
    // scripts/generate_installer_images.py.
    const offenders: string[] = []
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < WIX_BANNER_TITLE_SAFE_W; x++) {
        const [r, g, b] = bmp.pixelAt(x, y)
        if (
          Math.abs(r - WIX_BANNER_BG[0]) > 2 ||
          Math.abs(g - WIX_BANNER_BG[1]) > 2 ||
          Math.abs(b - WIX_BANNER_BG[2]) > 2
        ) {
          if (offenders.length < 5) offenders.push(`(${x}, ${y}) rgb(${r}, ${g}, ${b})`)
        }
      }
    }
    expect(offenders).toEqual([])
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
