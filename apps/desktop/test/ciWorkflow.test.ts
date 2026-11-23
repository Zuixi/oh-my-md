import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// CI is the only place clippy and dependency advisories run; a silent removal
// would look exactly like a green build, so the workflow contract is tested
// like any other cross-layer contract.
const WORKFLOW = readFileSync(
  resolve(process.cwd(), "..", "..", ".github", "workflows", "ci.yml"),
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

describe("CI workflow", () => {
  it("runs clippy with warnings denied on the Rust matrix", () => {
    const rust = jobBlock("rust", "bench")
    expect(rust).toContain("components: rustfmt, clippy")
    expect(rust).toContain(
      "cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings",
    )
    // Warnings-as-errors must not be softened by a continue-on-error gate.
    expect(rust).not.toContain("continue-on-error")
  })

  it("keeps a dependency audit job that is visible but advisory", () => {
    const audit = jobBlock("audit", "rust")
    expect(audit).toContain("pnpm audit --audit-level high")
    expect(audit).toContain("cargo audit --manifest-path apps/desktop/src-tauri/Cargo.toml")
    expect(audit).toContain("continue-on-error: true")
  })

  it("keeps the real-browser suite in the desktop gate", () => {
    const e2e = jobBlock("e2e", "audit")
    expect(e2e).toContain("playwright install chromium")
    expect(e2e).toContain("test:e2e")
  })
})
