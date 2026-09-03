import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
)

function jobBlock(name: string, nextName?: string): string {
  const start = WORKFLOW.indexOf(`  ${name}:\n`)
  if (start < 0) throw new Error(`missing ${name} job`)
  const end = nextName ? WORKFLOW.indexOf(`  ${nextName}:\n`, start + 1) : WORKFLOW.length
  return WORKFLOW.slice(start, end < 0 ? WORKFLOW.length : end)
}

describe("release workflow", () => {
  it("accepts only strict semver tags and supports artifacts-only manual runs", () => {
    expect(WORKFLOW).toContain('tags:\n      - "v[0-9]+.[0-9]+.[0-9]+"')
    expect(WORKFLOW).toContain("workflow_dispatch:")
    expect(WORKFLOW).toContain("github.event_name == 'push'")
  })

  it("validates the pushed tag against the Tauri version", () => {
    expect(WORKFLOW).toContain("apps/desktop/src-tauri/tauri.conf.json")
    expect(WORKFLOW).toContain("github.ref_name")
    expect(WORKFLOW).toMatch(/tag.*version|version.*tag/is)
  })

  it("builds and uploads the required packages on fixed platform runners", () => {
    const macos = jobBlock("macos", "windows")
    const windows = jobBlock("windows", "linux")
    const linux = jobBlock("linux", "publish")

    expect(macos).toContain("runs-on: macos-14")
    expect(macos).toContain("aarch64-apple-darwin")
    expect(macos).toContain("x86_64-apple-darwin")
    expect(macos).toMatch(/--target universal-apple-darwin.*--bundles dmg/s)
    expect(macos).toContain("actions/upload-artifact@")
    expect(macos).toContain("**/*.dmg")

    expect(windows).toContain("runs-on: windows-2022")
    expect(windows).not.toContain("runs-on: windows-latest")
    expect(windows).toMatch(/--bundles nsis,wix/)
    expect(windows).toContain("actions/upload-artifact@")
    expect(windows).toContain("**/*.msi")
    expect(windows).toContain("**/*-setup.exe")

    expect(linux).toContain("runs-on: ubuntu-22.04")
    expect(linux).toMatch(/--bundles deb,appimage/)
    expect(linux).toContain("actions/upload-artifact@")
    expect(linux).toContain("**/*.deb")
    expect(linux).toContain("**/*.AppImage")
  })

  it("aggregates all platforms, validates five package patterns, and publishes one draft", () => {
    const publish = jobBlock("publish")

    expect(publish).toContain("needs: [macos, windows, linux]")
    expect(publish).toContain("actions/download-artifact@")
    for (const pattern of ["*.dmg", "*.msi", "*-setup.exe", "*.deb", "*.AppImage"]) {
      expect(publish).toContain(pattern)
    }
    expect(publish).toContain("SHA256SUMS.txt")
    expect(publish).toMatch(/find .* -print0.*sort -z.*sha256sum/s)
    expect(publish).toContain("! -name SHA256SUMS.txt")
    expect(publish).toContain("softprops/action-gh-release@")
    expect(publish).toContain("draft: true")
    expect(publish).toMatch(/unsigned/i)
    expect(publish).toContain("if: github.event_name == 'push'")

    expect(WORKFLOW.match(/softprops\/action-gh-release@/g)).toHaveLength(1)
  })

  it("does not produce or publish auto-update metadata", () => {
    expect(WORKFLOW).not.toContain("latest.json")
    expect(WORKFLOW).not.toContain("createUpdaterArtifacts")
  })
})
