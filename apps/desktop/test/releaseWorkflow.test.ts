import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
).replace(/\r\n/g, "\n")
const SETUP_RUST_ACTION = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "actions", "setup-rust", "action.yml"),
  "utf8",
).replace(/\r\n/g, "\n")
const DEPENDABOT = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "dependabot.yml"),
  "utf8",
).replace(/\r\n/g, "\n")

function jobBlock(name: string, nextName?: string): string {
  // Anchor on the newline: `  rust:` also occurs inside the indented
  // paths-filter YAML of the `changes` job.
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`) + 1
  if (start <= 0) throw new Error(`missing ${name} job`)
  const end = nextName
    ? WORKFLOW.indexOf(`\n  ${nextName}:\n`, start + 1) + 1
    : WORKFLOW.length
  return WORKFLOW.slice(start, end < 0 ? WORKFLOW.length : end)
}

function dependabotUpdates(ecosystem: string): string {
  const start = DEPENDABOT.indexOf(`- package-ecosystem: ${ecosystem}\n`)
  if (start < 0) throw new Error(`missing ${ecosystem} dependabot rule`)
  const end = DEPENDABOT.indexOf("- package-ecosystem:", start + 1)
  return DEPENDABOT.slice(start, end < 0 ? DEPENDABOT.length : end)
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

    expect(macos).toContain("runs-on: macos-latest")
    expect(macos).toContain("aarch64-apple-darwin")
    expect(macos).toContain("x86_64-apple-darwin")
    expect(macos).toMatch(/--target universal-apple-darwin.*--bundles app,dmg/s)
    expect(macos).toContain("actions/upload-artifact@")
    expect(macos).toContain("**/*.dmg")

    expect(windows).toContain("runs-on: windows-2022")
    expect(windows).not.toContain("runs-on: windows-latest")
    expect(windows).toMatch(/--bundles nsis\b/)
    expect(windows).not.toMatch(/--bundles nsis,msi/)
    expect(windows).toContain("actions/upload-artifact@")
    expect(windows).not.toContain("**/*.msi")
    expect(windows).toContain("**/*-setup.exe")

    expect(linux).toContain("runs-on: ubuntu-22.04")
    expect(linux).toMatch(/--bundles deb,appimage/)
    expect(linux).toContain("actions/upload-artifact@")
    expect(linux).toContain("**/*.deb")
    expect(linux).toContain("**/*.AppImage")
  })

  it("aggregates all platforms, validates five package patterns, and publishes one draft", () => {
    const publish = jobBlock("publish")

    expect(publish).toContain("needs: [verify, macos, windows, linux]")
    expect(publish).toContain("actions/download-artifact@")
    for (const pattern of ["*.dmg", "*-setup.exe", "*.deb", "*.AppImage"]) {
      expect(publish).toContain(pattern)
    }
    expect(publish).not.toContain("'*.msi'")
    expect(publish).toContain("SHA256SUMS.txt")
    expect(publish).toMatch(/find .* -print0.*sort -z.*sha256sum/s)
    expect(publish).toContain("! -name SHA256SUMS.txt")
    expect(publish).toContain("softprops/action-gh-release@")
    expect(publish).toContain("draft: true")
    expect(publish).toMatch(/unsigned/i)
    expect(publish).toContain("if: github.event_name == 'push'")

    expect(WORKFLOW.match(/softprops\/action-gh-release@/g)).toHaveLength(1)
  })

  it("gates every platform builder and the draft on pre-release verification", () => {
    const verify = jobBlock("verify", "macos")
    expect(verify).toContain("pnpm check:quality")
    expect(verify).toContain("pnpm test")
    expect(verify).toContain("pnpm --filter @omd/desktop test")
    expect(verify).toContain("cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml")

    // The gate is only useful if the builders wait for it.
    for (const [name, next] of [
      ["macos", "windows"],
      ["windows", "linux"],
      ["linux", "publish"],
    ] as const) {
      expect(jobBlock(name, next)).toContain("needs: verify")
    }
    expect(jobBlock("publish")).toContain("verify")
  })

  it("keeps the draft release notes version-agnostic", () => {
    // A hardcoded version in the body ships a stale release page the moment the
    // tag moves on; notes must describe the current tag and the install path.
    const body = WORKFLOW.slice(
      WORKFLOW.indexOf("          body: |"),
      WORKFLOW.indexOf("          files: release-assets/*"),
    )
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(/\bv?\d+\.\d+\.\d+\b/)
    expect(WORKFLOW).toContain("github.ref_name")
    expect(WORKFLOW).toContain("CHANGELOG.md")
    expect(WORKFLOW).toContain("xattr -cr /Applications/oh-my-md.app")
    expect(WORKFLOW).toContain("SHA256SUMS.txt")
  })

  it("extracts the tagged CHANGELOG section into the draft release notes", () => {
    const publish = jobBlock("publish")
    const extract = publish.indexOf("node scripts/extract-release-notes.mjs")
    const draft = publish.indexOf("softprops/action-gh-release@")

    expect(extract).toBeGreaterThan(-1)
    expect(draft).toBeGreaterThan(extract)
    expect(publish).toContain("id: release_notes")
    expect(publish).toContain('--tag "${{ github.ref_name }}"')
    expect(publish).toContain("--changelog CHANGELOG.md")
    expect(publish).toContain('--github-output "$GITHUB_OUTPUT"')

    // The extracted body is substituted under the existing heading; a hardcoded
    // body would silently detach the release page from the changelog.
    const body = WORKFLOW.slice(
      WORKFLOW.indexOf("          body: |"),
      WORKFLOW.indexOf("          files: release-assets/*"),
    )
    const notesOutput = "            ${{ steps.release_notes.outputs.changelog }}"
    expect(body).toContain(`## What changed\n\n${notesOutput}`)
  })

  it("tracks GitHub Actions, npm/pnpm, and Cargo updates with grouped Dependabot rules", () => {
    // Actions stay weekly; lockfile ecosystems are grouped monthly on minor/patch
    // updates with major bumps ignored so Dependabot never floods the PR queue.
    const actions = dependabotUpdates("github-actions")
    expect(actions).toContain('directory: "/"')
    expect(actions).toContain("interval: weekly")
    expect(actions).toContain("open-pull-requests-limit: 2")
    expect(actions).toContain("groups:")

    for (const [ecosystem, directory] of [
      ["npm", "/"],
      ["cargo", "/apps/desktop/src-tauri"],
    ] as const) {
      const updates = dependabotUpdates(ecosystem)
      expect(updates).toContain(`directory: "${directory}"`)
      expect(updates).toContain("interval: monthly")
      expect(updates).toContain("open-pull-requests-limit: 2")
      expect(updates).toContain("groups:")
      expect(updates).toContain("version-update:semver-major")
    }
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
    for (const pattern of ["*-setup.exe", "*-setup.exe.sig"]) {
      expect(windows).toContain(`-name '${pattern}'`)
    }
    for (const pattern of ["*.deb", "*.AppImage", "*.AppImage.sig"]) {
      expect(linux).toContain(`-name '${pattern}'`)
    }
  })

  it("pins the NSIS asset name the updater deep-links to", () => {
    const windows = jobBlock("windows", "linux")
    const publish = jobBlock("publish")

    // windowsSetupAssetUrl in apps/desktop/src/constants.ts must produce
    // URLs to exactly this asset; both jobs fail the release on drift.
    for (const block of [windows, publish]) {
      expect(block).toContain("oh-my-md_${version}_x64-setup.exe")
    }
    expect(windows).toMatch(/Expected NSIS asset/)
    expect(publish).toMatch(/Expected NSIS asset/)
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
