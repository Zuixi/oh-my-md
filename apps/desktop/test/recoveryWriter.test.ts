import { afterEach, describe, expect, it, vi } from "vitest"
import { t } from "../src/i18n"
import { createRecoveryWriter, type RecoveryDraft, type RecoveryHost } from "../src/recoveryWriter"

function draftFor(tabId: number): RecoveryDraft {
  return { tabId, key: `notes_${tabId}_md`, path: `/notes/${tabId}.md`, contents: "body" }
}

function makeHost(write?: RecoveryHost["write"]) {
  const reportError = vi.fn()
  const host: RecoveryHost = { write, reportError }
  return { host, reportError }
}

afterEach(() => vi.restoreAllMocks())

describe("recovery writer", () => {
  it("reports the first failure for a tab and only logs the later ones", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await writer.save(draftFor(1), host)
    await writer.save(draftFor(1), host)

    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith(`${t("error.recoveryWriteFailed")}: disk full`)
    expect(logged).toHaveBeenCalledTimes(2)
    expect(logged.mock.calls[0]).toEqual([
      `${t("error.recoveryWriteFailed")}: disk full`,
      { key: "notes_1_md", path: "/notes/1.md" },
      new Error("disk full"),
    ])
  })

  it("re-arms the report after a successful write", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("first outage"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second outage"))
    const { host, reportError } = makeHost(write)
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await writer.save(draftFor(1), host)
    await writer.save(draftFor(1), host)

    expect(reportError.mock.calls).toEqual([
      [`${t("error.recoveryWriteFailed")}: first outage`],
      [`${t("error.recoveryWriteFailed")}: second outage`],
    ])
    expect(logged).not.toHaveBeenCalled()
  })

  it("tracks tabs separately and re-arms a forgotten tab", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await writer.save(draftFor(2), host)
    expect(reportError).toHaveBeenCalledTimes(2)

    writer.forget(1)
    await writer.save(draftFor(1), host)

    expect(reportError).toHaveBeenCalledTimes(3)
  })

  it("stays silent when the host cannot write recoveries", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(undefined)
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)

    expect(reportError).not.toHaveBeenCalled()
    expect(logged).not.toHaveBeenCalled()
  })
})
