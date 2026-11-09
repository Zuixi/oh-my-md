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
 * 一次中断只留一条 `error` 记录：返回它的消息，供测试断言 tab 身份字段。
 * 连续失败只累计计数，不再逐次打印。
 */
async function loggedFailure(draft: RecoveryDraft): Promise<string> {
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
  it("records one failure per outage instead of one per document change", async () => {
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
    // One record for the outage. Repeated failures of the same broken
    // directory used to write a line per keystroke.
    expect(logged).toHaveBeenCalledOnce()
    const [target, message] = logged.mock.calls[0]
    expect(target).toBe("recovery")
    expect(message).toBe(`${t("error.recoveryWriteFailed")}: disk full path=/notes/1.md`)
    // `path=` already identifies a named tab; the derived key would only add
    // an opaque duplicate. So the record must carry no key, in any form; a
    // regression that re-adds it fails here.
    expect(message).not.toContain("key=")
    expect(message).not.toContain(named.key)
  })

  it("keeps the key for an untitled tab, whose only identity is the key", async () => {
    vi.useFakeTimers()
    // `draft.path` is null for an untitled tab, whose generated `recoveryKey`
    // is its only identity; a path-only record would leave it anonymous.
    const message = await loggedFailure({
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

  it("re-arms reporting after a successful write and records the recovery", async () => {
    vi.useFakeTimers()
    const spy = useSpyLogger()
    const logged = vi.mocked(spy.error)
    const recovered = vi.mocked(spy.info)
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
    // One record per outage, and the success that ended the first one says how
    // many failed writes it covered.
    expect(logged).toHaveBeenCalledTimes(2)
    expect(logged.mock.calls[0][1]).toContain("first outage")
    expect(logged.mock.calls[1][1]).toContain("second outage")
    expect(recovered).toHaveBeenCalledOnce()
    expect(recovered.mock.calls[0][0]).toBe("recovery")
    expect(recovered.mock.calls[0][1]).toContain("recovered after 1 failed write(s)")
    expect(recovered.mock.calls[0][1]).toContain("path=/notes/1.md")
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
    expect(write).toHaveBeenCalledWith("notes_1_md", "/notes/1.md", "three")
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
    expect(write).toHaveBeenCalledWith("notes_1_md", "/notes/1.md", "x")
    writer.save(draftFor(2, "y"), host)
    writer.forget(2)
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe("recovery writer forget", () => {
  it("waits for an in-flight write and ignores its late success", async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const write = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const { host } = makeHost(write)
    const writer = createRecoveryWriter()
    const draft = draftFor(1)

    await writer.save(draft, host)
    await settle()
    expect(write).toHaveBeenCalledOnce()

    // Closing the tab must not delete the record while this IPC may still land.
    let forgotten = false
    const forgetting = writer.forget(1).then(() => { forgotten = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(forgotten).toBe(false)

    finish()
    await forgetting
    expect(forgotten).toBe(true)

    // The late success must not become the dedupe baseline: a recycled id with
    // the same draft still writes (its record was deleted after the close).
    await writer.save(draft, host)
    await settle()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it("does not report a write that failed after its tab was forgotten", async () => {
    vi.useFakeTimers()
    let fail!: (error: Error) => void
    const write = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const { host, reportError } = makeHost(write)
    const writer = createRecoveryWriter()

    await writer.save(draftFor(1), host)
    await settle()

    const forgetting = writer.forget(1)
    await vi.advanceTimersByTimeAsync(0)
    fail(new Error("disk full"))
    await forgetting

    // The tab is gone; a modal alert about its draft would be meaningless.
    expect(reportError).not.toHaveBeenCalled()
  })
})

// 持续失败只能留一条记录，但恢复那一行必须说清中断持续了多久：用户交上来的
// 诊断包要能回答"草稿这段时间到底有没有被保护"。
describe("recovery outage accounting", () => {
  it("reports the suppressed count when the outage ends", async () => {
    vi.useFakeTimers()
    const spy = useSpyLogger()
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined)
    const { host, reportError } = makeHost(write)
    const writer = createRecoveryWriter()

    for (const contents of ["a", "b", "c", "d"]) {
      await writer.save(draftFor(1, contents), host)
      await settle()
    }

    expect(reportError).toHaveBeenCalledOnce()
    expect(vi.mocked(spy.error)).toHaveBeenCalledOnce()
    const recovery = vi.mocked(spy.info).mock.calls[0]
    expect(recovery[0]).toBe("recovery")
    // Three writes failed (a, b, c) and the fourth succeeded: the count is the
    // number of writes that went unprotected, not the number of attempts.
    expect(recovery[1]).toContain("recovered after 3 failed write(s)")
  })
})
