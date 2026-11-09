import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearRecoveryAfterForget,
  clearRecoveryRecord,
  createPendingRecoveryCanceller,
} from "../src/recoveryCleanup"
import { createFileSession } from "../src/session"
import { versionFor } from "./fakeDisk"
import { useSpyLogger } from "./setup"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("clearRecoveryRecord", () => {
  it("resolves when the wire layer offers no clear operation", async () => {
    await expect(clearRecoveryRecord({}, "key_0123456789abcdef")).resolves.toBeUndefined()
  })

  it("swallows a rejected delete and logs it with the opaque key", async () => {
    const warn = vi.mocked(useSpyLogger().warn)
    const clearRecovery = vi.fn().mockRejectedValue(new Error("locked"))

    // Cleanup runs in tab close / save-as / conflict paths where an unhandled
    // rejection would surface as a global error and abort the workflow; the
    // record simply stays for the next launch.
    await expect(
      clearRecoveryRecord({ clearRecovery }, "key_0123456789abcdef"),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    const [target, message] = warn.mock.calls[0]
    expect(target).toBe("recovery")
    expect(message).toContain("key=key_0123456789abcdef")
    expect(message).toContain("locked")
  })
})

describe("createPendingRecoveryCanceller", () => {
  const tab = createFileSession(1, "/notes/a.md", "disk", versionFor("/notes/a.md", "disk"))

  it("forgets the pending write, then re-arms an edit made during the save", async () => {
    const events: string[] = []
    const forget = vi.fn(async () => { events.push("forget") })
    const save = vi.fn(() => { events.push("save") })
    const cancel = createPendingRecoveryCanceller({
      forget,
      load: () => [tab, "disk + late edit"],
      save,
    })

    await cancel(1)

    // The debounced write under the old key must settle before a draft is
    // armed under the new one, or the late write could land after save-as.
    expect(events).toEqual(["forget", "save"])
    expect(save).toHaveBeenCalledWith(tab, "disk + late edit")
  })

  it("stays inert when the tab is gone or no longer dirty", async () => {
    const save = vi.fn()
    const missing = createPendingRecoveryCanceller({
      forget: async () => undefined,
      load: () => [undefined, "text"],
      save,
    })
    const clean = createPendingRecoveryCanceller({
      forget: async () => undefined,
      load: () => [tab, "disk"],
      save,
    })

    await missing(1)
    await clean(1)

    expect(save).not.toHaveBeenCalled()
  })
})

describe("clearRecoveryAfterForget", () => {
  it("deletes the record only after the in-flight write settles", async () => {
    let release!: () => void
    const forget = new Promise<void>(resolve => { release = resolve })
    const clearRecovery = vi.fn().mockResolvedValue(undefined)

    clearRecoveryAfterForget(forget, { clearRecovery }, "key_0123456789abcdef")
    await Promise.resolve()
    expect(clearRecovery).not.toHaveBeenCalled()

    release()
    await forget
    await vi.waitFor(() => expect(clearRecovery).toHaveBeenCalledOnce())
  })
})
