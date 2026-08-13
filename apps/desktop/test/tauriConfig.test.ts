import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as unknown
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
