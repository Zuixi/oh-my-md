import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Drift guard for the version values that must stay in sync. The single
 * source of truth is `src-tauri/tauri.conf.json` `version`; the root
 * `package.json`, the desktop `package.json`, `src-tauri/Cargo.toml`, and
 * the local `omd` package in `Cargo.lock` must all match it. The first public
 * release is fixed at 0.0.1; `scripts/sync-version.sh` keeps these locations
 * aligned for later releases.
 */

const RELEASE_VERSION = "0.0.1"
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
  const source = readFileSync(path, "utf8")
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

describe("version single-source sync", () => {
  const versions: Record<string, string> = {
    "root package.json": jsonVersion(ROOT_PACKAGE),
    "desktop package.json": jsonVersion(DESKTOP_PACKAGE),
    "Cargo.toml": cargoVersion(CARGO_TOML),
    "Cargo.lock local omd": localCargoLockVersion(CARGO_LOCK),
    "tauri.conf.json": jsonVersion(TAURI_CONF),
  }

  it("pins every release version location to 0.0.1", () => {
    for (const [label, value] of Object.entries(versions)) {
      expect(value, `${label} must identify the first public release`).toBe(RELEASE_VERSION)
    }
  })

  it("all version locations agree with tauri.conf.json", () => {
    for (const [label, value] of Object.entries(versions)) {
      expect(value, `${label} version differs from tauri.conf.json`).toBe(
        versions["tauri.conf.json"],
      )
    }
  })

  it("scripts/sync-version.sh exists", () => {
    expect(scriptExists(SYNC_SCRIPT), `missing ${SYNC_SCRIPT}`).toBe(true)
  })
})
