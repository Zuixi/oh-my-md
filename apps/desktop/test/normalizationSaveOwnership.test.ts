import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const coordinator = readFileSync(
  join(import.meta.dirname, "../src/normalizationCoordinator.ts"),
  "utf8",
)
const runner = readFileSync(
  join(import.meta.dirname, "../src/documentSaveRunner.ts"),
  "utf8",
)

describe("normalization save ownership", () => {
  it("keeps document persistence in documentSaveRunner only", () => {
    expect(coordinator).not.toContain("export interface TabSaveHost")
    expect(coordinator).not.toContain("export function createTabSaver")
    expect(coordinator).not.toContain("host.writeFile(")
    expect(runner).toContain("host.saveDocument(targetPath, snapshot, expected)")
    expect(runner).toContain("completeAccept(")
  })
})
