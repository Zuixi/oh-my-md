import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Drift guard for the version values that must stay in sync. The single
 * source of truth is `src-tauri/tauri.conf.json` `version`; the root
 * `package.json`, the desktop `package.json`, `src-tauri/Cargo.toml`, and
 * the local `omd` package in `Cargo.lock` must all match it.
 * `scripts/sync-version.sh` keeps these locations aligned for releases.
 */

const ROOT_PACKAGE = resolve(process.cwd(), "..", "..", "package.json")
const DESKTOP_PACKAGE = resolve(process.cwd(), "package.json")
const CARGO_TOML = resolve(process.cwd(), "src-tauri", "Cargo.toml")
const CARGO_LOCK = resolve(process.cwd(), "src-tauri", "Cargo.lock")
const TAURI_CONF = resolve(process.cwd(), "src-tauri", "tauri.conf.json")
const SYNC_SCRIPT = resolve(process.cwd(), "..", "..", "scripts", "sync-version.sh")

function jsonVersion(path: string): string {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string }
  return pkg.version ?? ""
}

function cargoVersion(path: string): string {
  const source = readFileSync(path, "utf8")
  const match = /^version\s*=\s*"([^"]+)"/m.exec(source)
  if (!match) throw new Error(`missing version in ${path}`)
  return match[1]
}

function localCargoLockVersion(path: string): string {
  // Cargo writes LF, but a Windows checkout with core.autocrlf=true reads the
  // lockfile back as CRLF; normalize before the structural match.
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
  const match = /\[\[package\]\]\nname = "omd"\nversion = "([^"]+)"/.exec(source)
  if (!match) throw new Error(`missing local omd package version in ${path}`)
  return match[1]
}

function scriptExists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

const tempDirs: string[] = []

function fixtureRepo(files: ReadonlyArray<readonly [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "omd-sync-version-"))
  tempDirs.push(root)
  for (const [relative, contents] of files) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }
  return root
}

/** A Cargo.lock shape the sync must respect: the local `omd` package sits
 * between two dependency packages that must keep their versions exactly. */
const FIXTURE_CARGO_LOCK = [
  "version = 4",
  "",
  "[[package]]",
  'name = "anyhow"',
  'version = "1.0.98"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  "",
  "[[package]]",
  'name = "omd"',
  'version = "0.0.1"',
  "dependencies = [",
  ' "anyhow",',
  "]",
  "",
  "[[package]]",
  'name = "omd-smoke"',
  'version = "9.9.9"',
  "",
  "[[package]]",
  'name = "serde"',
  'version = "1.0.228"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  "",
].join("\n")

afterEach(() => {
  let dir: string | undefined
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("version single-source sync", () => {
  const versions: Record<string, string> = {
    "root package.json": jsonVersion(ROOT_PACKAGE),
    "desktop package.json": jsonVersion(DESKTOP_PACKAGE),
    "Cargo.toml": cargoVersion(CARGO_TOML),
    "Cargo.lock local omd": localCargoLockVersion(CARGO_LOCK),
    "tauri.conf.json": jsonVersion(TAURI_CONF),
  }

  it("all five version locations agree with tauri.conf.json", () => {
    for (const [label, value] of Object.entries(versions)) {
      expect(value, `${label} version differs from tauri.conf.json`).toBe(
        versions["tauri.conf.json"],
      )
    }
  })

  it("tauri.conf.json is a strict semver source of truth", () => {
    expect(versions["tauri.conf.json"]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("scripts/sync-version.sh exists", () => {
    expect(scriptExists(SYNC_SCRIPT), `missing ${SYNC_SCRIPT}`).toBe(true)
  })

  it("scripts/sync-version.sh keeps the Cargo.lock local omd entry in sync", () => {
    const script = readFileSync(SYNC_SCRIPT, "utf8")
    expect(script).toContain("apps/desktop/src-tauri/Cargo.lock")
    // A full `cargo update` would rewrite every dependency version; the script
    // must patch the single local [[package]] entry instead.
    expect(script).not.toMatch(/^\s*cargo update/m)
  })
})

describe("Cargo.lock version rewrite", () => {
  it("bumps only the local omd package and leaves neighbours byte-identical", () => {
    const root = fixtureRepo([
      ["scripts/sync-version.sh", readFileSync(SYNC_SCRIPT, "utf8")],
      ["package.json", JSON.stringify({ name: "oh-my-md", version: "0.0.1" }, null, 2) + "\n"],
      [
        "apps/desktop/package.json",
        JSON.stringify({ name: "@omd/desktop", version: "0.0.1" }, null, 2) + "\n",
      ],
      [
        "apps/desktop/src-tauri/tauri.conf.json",
        JSON.stringify({ productName: "oh-my-md", version: "0.0.1" }, null, 2) + "\n",
      ],
      ["apps/desktop/src-tauri/Cargo.toml", '[package]\nname = "omd"\nversion = "0.0.1"\n'],
      ["apps/desktop/src-tauri/Cargo.lock", FIXTURE_CARGO_LOCK],
    ])
    const scriptCopy = join(root, "scripts", "sync-version.sh")

    const stdout = execFileSync("bash", [scriptCopy, "1.2.3"], {
      encoding: "utf8",
      cwd: root,
    })

    // Every version location, including the lockfile, is reported.
    for (const file of [
      "package.json",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/Cargo.toml",
      "apps/desktop/src-tauri/Cargo.lock",
      "apps/desktop/src-tauri/tauri.conf.json",
    ]) {
      expect(stdout).toContain(file)
    }

    const lock = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8")
    expect(lock).toBe(FIXTURE_CARGO_LOCK.replace('version = "0.0.1"', 'version = "1.2.3"'))
    // The near-miss package name proves the rewrite is anchored to `omd`.
    expect(lock).toContain('name = "omd-smoke"\nversion = "9.9.9"')
    expect(lock).toContain('name = "anyhow"\nversion = "1.0.98"')
    expect(lock).toContain('name = "serde"\nversion = "1.0.228"')

    const tauriConf = JSON.parse(
      readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string }
    expect(tauriConf.version).toBe("1.2.3")
    const desktopPkg = JSON.parse(
      readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
    ) as { version: string }
    expect(desktopPkg.version).toBe("1.2.3")
    // The sed rewrite for Cargo.toml must not leave a .bak file behind.
    expect(scriptExists(join(root, "apps/desktop/src-tauri/Cargo.toml"))).toBe(true)
    expect(scriptExists(join(root, "apps/desktop/src-tauri/Cargo.toml.bak"))).toBe(false)
  })
})
