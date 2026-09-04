import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
)
const SETUP_RUST_ACTION = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "actions", "setup-rust", "action.yml"),
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
    expect(macos).toMatch(/--target universal-apple-darwin.*--bundles app,dmg/s)
    expect(macos).toContain("actions/upload-artifact@")
    expect(macos).toContain("**/*.dmg")

    expect(windows).toContain("runs-on: windows-2022")
    expect(windows).not.toContain("runs-on: windows-latest")
    expect(windows).toMatch(/--bundles nsis,msi/)
    expect(windows).not.toMatch(/--bundles nsis,wix/)
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

  it("installs the Linux dependency needed to render SVG app icons", () => {
    expect(SETUP_RUST_ACTION).toContain("librsvg2-dev")
  })

  it("normalizes the updater key into a temporary file only in platform build jobs", () => {
    const macos = jobBlock("macos", "windows")
    const windows = jobBlock("windows", "linux")
    const linux = jobBlock("linux", "publish")
    const publish = jobBlock("publish")

    for (const block of [macos, windows, linux]) {
      expect(block).toContain("RUSTFLAGS: -D warnings")
      expect(block).toContain("UPDATER_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")
      expect(block).toContain("node scripts/prepare-updater-key.mjs")
      expect(block).toContain("env -u TAURI_SIGNING_PRIVATE_KEY pnpm")
      expect(block).toContain("tauri signer sign --private-key-path")
      expect(block).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}")
      expect(block).not.toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}")
    }
    expect(publish).not.toContain("UPDATER_PRIVATE_KEY")
    expect(publish).not.toContain("TAURI_SIGNING_PRIVATE_KEY")
    expect(publish).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
  })

  it("requires every platform's installer and updater assets before upload", () => {
    const macos = jobBlock("macos", "windows")
    const windows = jobBlock("windows", "linux")
    const linux = jobBlock("linux", "publish")

    for (const pattern of ["*.dmg", "*.app.tar.gz", "*.app.tar.gz.sig"]) {
      expect(macos).toContain(`-name '${pattern}'`)
    }
    for (const pattern of ["*.msi", "*-setup.exe", "*-setup.exe.sig"]) {
      expect(windows).toContain(`-name '${pattern}'`)
    }
    for (const pattern of ["*.deb", "*.AppImage", "*.AppImage.sig"]) {
      expect(linux).toContain(`-name '${pattern}'`)
    }
  })

  it("uploads signed updater artifacts and signatures for every platform", () => {
    const macos = jobBlock("macos", "windows")
    const windows = jobBlock("windows", "linux")
    const linux = jobBlock("linux", "publish")

    expect(macos).toContain("**/*.app.tar.gz")
    expect(macos).toContain("**/*.app.tar.gz.sig")
    expect(windows).toContain("**/*-setup.exe.sig")
    expect(linux).toContain("**/*.AppImage.sig")
    expect(linux).not.toContain("**/*.AppImage.tar.gz")
  })

  it("stages updater artifacts, then generates and validates the candidate manifest before checksums and the Draft", () => {
    const publish = jobBlock("publish")

    for (const pattern of [
      "*.app.tar.gz",
      "*.app.tar.gz.sig",
      "*-setup.exe.sig",
      "*.AppImage",
      "*.AppImage.sig",
    ]) {
      expect(publish).toContain(`'${pattern}'`)
    }

    const candidate = publish.indexOf("update-manifest.mjs candidate")
    const validate = publish.indexOf("update-manifest.mjs validate")
    const checksum = publish.indexOf("sha256sum > SHA256SUMS.txt")
    const draft = publish.indexOf("softprops/action-gh-release@")

    expect(candidate).toBeGreaterThan(-1)
    expect(publish).toContain("--output release-assets/latest.json")
    expect(publish).toContain("--assets release-assets")
    expect(publish).toContain('--tag "${{ github.ref_name }}"')
    expect(validate).toBeGreaterThan(candidate)
    expect(checksum).toBeGreaterThan(validate)
    expect(draft).toBeGreaterThan(checksum)
  })

  it("checksums every staged asset, including the candidate manifest and signatures", () => {
    const publish = jobBlock("publish")

    // latest.json must exist before the checksum run, and the find excludes
    // only the checksum file itself, so the manifest and every .sig are hashed.
    expect(publish).toContain("test -f latest.json")
    expect(publish).toContain("! -name SHA256SUMS.txt")
    expect(publish).toContain("files: release-assets/*")
  })
})
