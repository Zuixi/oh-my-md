import { describe, expect, it, vi } from "vitest"
import { SAVE_COPY_SAME_PATH_MESSAGE } from "../src/conflictActions"
import { createSaveCopy } from "../src/documentSaveRunner"
import { createFileSession } from "../src/session"

describe("save copy path identity", () => {
  it("refuses the resolved path in a different Windows form", async () => {
    const reportStatus = vi.fn()
    const saveDocument = vi.fn(async () => {
      throw new Error("the same-path check must run before saving")
    })
    const saveCopy = createSaveCopy({
      // Rust reports the canonical (extended-length) spelling; the picker
      // returns the native one. Both name the same file.
      getTab: () => createFileSession(1, "C:\\notes\\a.md", "mine", {
        resolvedPath: "\\\\?\\C:\\notes\\a.md",
        fingerprint: "v1:aa",
      }),
      getContents: () => "mine",
      pickSavePath: async () => "C:\\notes\\a.md",
      readDocumentVersion: async () => {
        throw new Error("the same-path check must run before probing")
      },
      saveDocument,
      allowDocumentAssets: async () => undefined,
      enqueue: async (_tabId, work) => work(),
      reportStatus,
    })

    await saveCopy(1)

    expect(reportStatus).toHaveBeenCalledWith(SAVE_COPY_SAME_PATH_MESSAGE)
    expect(saveDocument).not.toHaveBeenCalled()
  })
})
