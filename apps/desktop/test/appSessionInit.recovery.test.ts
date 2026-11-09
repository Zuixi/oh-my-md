import { describe, expect, it, vi } from "vitest"
import { restoreDrafts, type AppSessionInitHost } from "../src/appSessionInit"
import type { DesktopServices } from "../src/desktopServices"
import { createSession, recoveryKey } from "../src/session"
import { DEFAULT_SETTINGS } from "../src/settings"
import { addTab, createWorkspace, type Workspace } from "../src/workspace"

// The key each adopted tab will write under from now on (default window: "main").
const KEY_2 = recoveryKey(createSession(2))
const KEY_3 = recoveryKey(createSession(3))

function makeHost(
  services: Partial<DesktopServices>,
  options: {
    adopt?: ReturnType<typeof vi.fn>
    workspace?: Workspace
    ensureDraftTarget?: ReturnType<typeof vi.fn>
  } = {},
) {
  const ensureDraftTarget = options.ensureDraftTarget ?? vi.fn(async () => {})
  const adopt = options.adopt ?? vi.fn(() => null)
  const workspace = options.workspace ?? createWorkspace()
  const host = {
    services: services as DesktopServices,
    documentScaleRegistry: {} as unknown as AppSessionInitHost["documentScaleRegistry"],
    isMounted: () => true,
    applySpellcheck: () => {},
    applyAutoPair: () => {},
    getSettingsState: () => DEFAULT_SETTINGS,
    commitSettings: () => {},
    commitTheme: () => {},
    getWorkspace: () => workspace,
    commitWorkspace: () => {},
    getContents: () => "",
    setContents: () => {},
    resetTabDocument: () => true,
    ensureDraftTarget,
    adoptRecovery: adopt,
    syncDoc: () => {},
    markSessionRestored: () => {},
  } satisfies AppSessionInitHost
  return { host, adopt, ensureDraftTarget }
}

describe("draft recovery startup", () => {
  it("keeps offering records when deleting one fails", async () => {
    const clearRecovery = vi.fn()
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValue(undefined)
    const writeRecovery = vi.fn().mockResolvedValue(undefined)
    // Each adopted draft lands in a tab whose recovery key differs from the
    // record's, so the record must be re-armed before it may be deleted.
    const workspace = addTab(addTab(createWorkspace(), createSession(2)), createSession(3))
    const { host, adopt, ensureDraftTarget } = makeHost({
      listRecoveries: async () => [
        { key: "_a.md", label: "/a.md", path: "/a.md" },
        { key: "untitled_main_2", label: "untitled_main_2", path: null },
      ],
      confirmRestore: () => true,
      readRecovery: async key => ({ path: key === "_a.md" ? "/a.md" : null, contents: "draft" }),
      writeRecovery,
      clearRecovery,
    }, { adopt: vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(3), workspace })

    await restoreDrafts(host)

    expect(adopt).toHaveBeenCalledTimes(2)
    // The envelope's path (not the opaque record key) is what adoption matches on.
    expect(adopt).toHaveBeenCalledWith({ key: "_a.md", path: "/a.md", contents: "draft" })
    // The lazy tab holding this path must learn its disk baseline first; a
    // path-less draft has no tab to load.
    expect(ensureDraftTarget).toHaveBeenCalledTimes(1)
    expect(ensureDraftTarget).toHaveBeenCalledWith("/a.md")
    // Both keys differ from the records', so both drafts are re-armed first.
    expect(writeRecovery).toHaveBeenCalledTimes(2)
    expect(writeRecovery).toHaveBeenNthCalledWith(1, KEY_2, null, "draft")
    expect(writeRecovery).toHaveBeenNthCalledWith(2, KEY_3, null, "draft")
    expect(clearRecovery).toHaveBeenCalledTimes(2)
    expect(clearRecovery).toHaveBeenNthCalledWith(1, "_a.md")
    expect(clearRecovery).toHaveBeenNthCalledWith(2, "untitled_main_2")
  })

  it("retains an unreadable record and continues with the next one", async () => {
    const clearRecovery = vi.fn().mockResolvedValue(undefined)
    const readRecovery = vi.fn(async (key: string) => {
      if (key === "broken") throw new Error("unreadable")
      return { path: null, contents: "draft" }
    })
    const { host, adopt } = makeHost({
      listRecoveries: async () => [
        { key: "broken", label: "broken", path: null },
        { key: "untitled_main_2", label: "untitled_main_2", path: null },
      ],
      confirmRestore: () => true,
      readRecovery,
      clearRecovery,
    })

    await restoreDrafts(host)

    expect(adopt).toHaveBeenCalledTimes(1)
    expect(clearRecovery).not.toHaveBeenCalledWith("broken")
  })

  it("keeps a record the adopted tab already points at", async () => {
    // The draft is memory-only after mounting; the record under the tab's own
    // key is its only durable copy, so it must not be deleted.
    const clearRecovery = vi.fn().mockResolvedValue(undefined)
    const writeRecovery = vi.fn().mockResolvedValue(undefined)
    const workspace = addTab(createWorkspace(), createSession(2))
    const { host } = makeHost({
      listRecoveries: async () => [
        { key: KEY_2, label: KEY_2, path: null },
      ],
      confirmRestore: () => true,
      readRecovery: async () => ({ path: null, contents: "draft" }),
      writeRecovery,
      clearRecovery,
    }, { adopt: vi.fn(() => 2), workspace })

    await restoreDrafts(host)

    expect(writeRecovery).not.toHaveBeenCalled()
    expect(clearRecovery).not.toHaveBeenCalled()
  })

  it("keeps offering records when loading a lazy draft target fails", async () => {
    // A failed lazy load must not abort the loop or reject the startup flow;
    // adoption falls back to opening a fresh tab holding the draft.
    const clearRecovery = vi.fn().mockResolvedValue(undefined)
    const ensureDraftTarget = vi.fn()
      .mockRejectedValueOnce(new Error("stat failed"))
      .mockResolvedValue(undefined)
    const { host, adopt } = makeHost({
      listRecoveries: async () => [
        { key: "_a.md", label: "/a.md", path: "/a.md" },
        { key: "_b.md", label: "/b.md", path: "/b.md" },
      ],
      confirmRestore: () => true,
      readRecovery: async key => ({
        path: key === "_a.md" ? "/a.md" : "/b.md",
        contents: "draft",
      }),
      clearRecovery,
    }, { adopt: vi.fn(() => null), ensureDraftTarget })

    await restoreDrafts(host)

    expect(ensureDraftTarget).toHaveBeenCalledTimes(2)
    expect(adopt).toHaveBeenCalledTimes(2)
  })

  it("keeps the old record when re-arming under the new key fails", async () => {
    const clearRecovery = vi.fn().mockResolvedValue(undefined)
    const writeRecovery = vi.fn().mockRejectedValue(new Error("disk full"))
    const workspace = addTab(createWorkspace(), createSession(2))
    const { host } = makeHost({
      listRecoveries: async () => [
        { key: "_a.md", label: "/a.md", path: "/a.md" },
      ],
      confirmRestore: () => true,
      readRecovery: async () => ({ path: "/a.md", contents: "draft" }),
      writeRecovery,
      clearRecovery,
    }, { adopt: vi.fn(() => 2), workspace })

    await restoreDrafts(host)

    expect(writeRecovery).toHaveBeenCalledWith(KEY_2, null, "draft")
    expect(clearRecovery).not.toHaveBeenCalled()
  })
})
