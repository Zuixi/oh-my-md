import { afterEach, describe, expect, it, vi } from "vitest"
import { t } from "../src/i18n"
import {
  createRecoveryWriter, RECOVERY_DEBOUNCE_MS,
  type RecoveryDraft, type RecoveryHost,
} from "../src/recoveryWriter"

function draftFor(tabId: number, contents = "body"): RecoveryDraft {
  return { tabId, key: `notes_${tabId}_md`, path: `/notes/${tabId}.md`, contents }
}

function makeHost(write?: RecoveryHost["write"]) {
  const reportError = vi.fn()
  const host: RecoveryHost = { write, reportError }
  return { host, reportError }
}

/** 防抖节奏：save 后推进到 trailing 边缘，等待挂起写真正执行。 */
async function settle() {
  await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("recovery writer", () => {
  it("reports the first failure for a tab and only logs the later ones", async () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await settle()
    await writer.save(draftFor(1), host)
    await settle()
    await writer.save(draftFor(1), host)
    await settle()

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
    vi.useFakeTimers()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("first outage"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second outage"))
    const { host, reportError } = makeHost(write)
    const writer = createRecoveryWriter()

    // 内容逐次变化：去重不介入，专测「失败→成功→再失败」的上报重武装。
    await writer.save(draftFor(1, "a"), host)
    await settle()
    await writer.save(draftFor(1, "b"), host)
    await settle()
    await writer.save(draftFor(1, "c"), host)
    await settle()

    expect(reportError.mock.calls).toEqual([
      [`${t("error.recoveryWriteFailed")}: first outage`],
      [`${t("error.recoveryWriteFailed")}: second outage`],
    ])
    expect(logged).not.toHaveBeenCalled()
  })

  it("tracks tabs separately and re-arms a forgotten tab", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await settle()
    await writer.save(draftFor(2), host)
    await settle()
    expect(reportError).toHaveBeenCalledTimes(2)

    writer.forget(1)
    await writer.save(draftFor(1), host)
    await settle()

    expect(reportError).toHaveBeenCalledTimes(3)
  })

  it("stays silent when the host cannot write recoveries", async () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { host, reportError } = makeHost(undefined)
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await settle()

    expect(reportError).not.toHaveBeenCalled()
    expect(logged).not.toHaveBeenCalled()
  })

  it("debounces rapid saves into one trailing write", async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => undefined)
    const writer = createRecoveryWriter()
    const { host } = makeHost(write)
    writer.save(draftFor(1, "one"), host)
    writer.save(draftFor(1, "two"), host)
    writer.save(draftFor(1, "three"), host)
    expect(write).not.toHaveBeenCalled()
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith("notes_1_md", "three")
  })

  it("skips the write when contents are unchanged since the last write", async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => undefined)
    const writer = createRecoveryWriter()
    const { host } = makeHost(write)
    writer.save(draftFor(1, "same"), host)
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
    writer.save(draftFor(1, "same"), host)
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("settles a pending write on the debounce and forget cancels it", async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => undefined)
    const writer = createRecoveryWriter()
    const { host } = makeHost(write)
    writer.save(draftFor(1, "x"), host)
    await settle()
    expect(write).toHaveBeenCalledWith("notes_1_md", "x")
    writer.save(draftFor(2, "y"), host)
    writer.forget(2)
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
  })
})
