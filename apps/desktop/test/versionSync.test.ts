import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Drift guard for the version values that must stay in sync. The single
 * source of truth is `src-tauri/tauri.conf.json` `version`; the root
 * `package.json`, the desktop `package.json`, and `src-tauri/Cargo.toml`
 * must all match it. `scripts/sync-version.sh` is the mechanism that keeps
 * them aligned.
 */

const ROOT_PACKAGE = resolve(process.cwd(), "..", "..", "package.json")
const DESKTOP_PACKAGE = resolve(process.cwd(), "package.json")
const CARGO_TOML = resolve(process.cwd(), "src-tauri", "Cargo.toml")
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
    "tauri.conf.json": jsonVersion(TAURI_CONF),
  }

  it("all four version locations agree", () => {
    const values = Object.values(versions)
    for (const [label, value] of Object.entries(versions)) {
      expect(value, `${label} version differs from tauri.conf.json`).toBe(
        versions["tauri.conf.json"],
      )
    }
    expect(new Set(values).size).toBe(1)
  })

  it("tauri.conf.json is the non-empty source of truth", () => {
    expect(versions["tauri.conf.json"]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("scripts/sync-version.sh exists", () => {
    expect(scriptExists(SYNC_SCRIPT), `missing ${SYNC_SCRIPT}`).toBe(true)
  })
})
