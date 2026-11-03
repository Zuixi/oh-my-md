import { describe, expect, it, vi } from "vitest"
import { reportSaveStateTransitions } from "../src/saveDiagnostics"
import { initialSaveState } from "../src/documentSaveState"
import { createFileSession } from "../src/session"
import { versionFor } from "./fakeDisk"
import { useSpyLogger } from "./setup"

it("logs committed conflict transitions once without copying the document", () => {
  const logger = useSpyLogger()
  const tab = createFileSession(1, "/notes/private.md", "private body", versionFor("/notes/private.md", "private body"))
  const before = { 1: initialSaveState() }
  const changed = { 1: { ...initialSaveState(), divergence: { kind: "deletedExternally" as const, localSnapshot: "private body" } } }
  reportSaveStateTransitions(before, changed, () => tab)
  expect(logger.info).toHaveBeenCalledExactlyOnceWith("document", expect.stringContaining("divergence=deletedExternally"))
  reportSaveStateTransitions(changed, { ...changed }, () => tab)
  expect(logger.info).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("private body")
})

describe("quiet document lifecycle", () => {
  it("does not enumerate document content or emit saving/idle churn", () => {
    const logger = useSpyLogger()
    const before = { 1: initialSaveState() }
    const saving = { 1: { ...initialSaveState(), lifecycle: { kind: "saving" as const, operationId: 1, snapshot: "body" } } }
    reportSaveStateTransitions(before, saving, () => undefined)
    reportSaveStateTransitions(saving, before, () => undefined)
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
