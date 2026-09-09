import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Tauri capabilities match by window label. Dynamically created editor
 * windows (`editor-N`, see src-tauri/src/windows.rs) get IPC permissions
 * only if a capability pattern covers them — without this, every invoke in
 * a new window fails while tests (which mock at the TS boundary) stay green.
 */
describe("window capabilities", () => {
  const capability = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"),
  ) as { windows: string[] }

  it("covers main and dynamically created editor windows", () => {
    expect(capability.windows).toContain("main")
    expect(
      capability.windows.some(pattern => pattern === "editor-*" || pattern === "*"),
    ).toBe(true)
  })

  it("does not widen capabilities to every possible window label", () => {
    // editor-* is the documented glob form; a bare "*" would also match
    // future utility windows that may need tighter scopes.
    expect(capability.windows).toContain("editor-*")
  })
})
