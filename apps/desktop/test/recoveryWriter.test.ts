import { afterEach, describe, expect, it, vi } from "vitest"
import { t } from "../src/i18n"
import {
  createRecoveryWriter, RECOVERY_DEBOUNCE_MS,
  type RecoveryDraft, type RecoveryHost,
} from "../src/recoveryWriter"
import { useSpyLogger } from "./setup"

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

/**
 * 第二次失败的记录：第一次走 `reportError`，之后每次都写结构化日志。
 * 返回那条 `error` 记录的消息，供测试断言 tab 身份字段。
 */
async function loggedSecondFailure(draft: RecoveryDraft): Promise<string> {
  const logged = vi.mocked(useSpyLogger().error)
  const { host } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
  const writer = createRecoveryWriter()

  await writer.save(draft, host)
  await settle()
  await writer.save(draft, host)
  await settle()

  expect(logged).toHaveBeenCalledOnce()
  const [target, message] = logged.mock.calls[0]
  expect(target).toBe("recovery")
  return message
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("recovery writer", () => {
  it("reports the first failure for a tab and only logs the later ones", async () => {
    vi.useFakeTimers()
    const logged = vi.mocked(useSpyLogger().error)
    const { host, reportError } = makeHost(vi.fn().mockRejectedValue(new Error("disk full")))
    const writer = createRecoveryWriter()
    // `/notes/1.md` — a tab with a path, so `path=` already identifies it.
    const named = draftFor(1)

    await writer.save(named, host)
    await settle()
    await writer.save(named, host)
    await settle()
    await writer.save(named, host)
    await settle()

    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith(`${t("error.recoveryWriteFailed")}: disk full`)
    expect(logged).toHaveBeenCalledTimes(2)
    const [target, message] = logged.mock.calls[0]
    expect(target).toBe("recovery")
    expect(message).toBe(`${t("error.recoveryWriteFailed")}: disk full path=/notes/1.md`)
    // `path=` identifies a named tab, and `recoveryKey` is derived from that path
    // (`notes_1_md`) — a separator-substituted copy the export redactor's
    // separator rule cannot collapse. So the record must carry no key, in any
    // form; a regression that re-adds it fails here.
    expect(message).not.toContain("key=")
    expect(message).not.toContain(named.key)
  })

  it("keeps the key for an untitled tab, whose only identity is the key", async () => {
    vi.useFakeTimers()
    // `draft.path` is null for an untitled tab (`recoveryKey` gives it
    // `untitled_<id>`); a path-only record would leave that tab anonymous.
    const message = await loggedSecondFailure({
      tabId: 7,
      key: "untitled_7",
      path: null,
      contents: "body",
    })

    expect(message).toBe(
      `${t("error.recoveryWriteFailed")}: disk full path= key=untitled_7`,
    )
    expect(message).toContain("key=untitled_7")
  })

  it("re-arms the report after a successful write", async () => {
    vi.useFakeTimers()
    const logged = vi.mocked(useSpyLogger().error)
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
    useSpyLogger()
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
    const logged = vi.mocked(useSpyLogger().error)
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
