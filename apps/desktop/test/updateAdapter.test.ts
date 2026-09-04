import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createTauriUpdateAdapter,
  type AdapterDownloadEvent,
} from "../src/updateAdapter"

const { pluginCheck, processRelaunch } = vi.hoisted(() => ({
  pluginCheck: vi.fn(),
  processRelaunch: vi.fn(),
}))

// The adapter consumes the official @tauri-apps/plugin-updater Update shape
// (currentVersion/version/body/date + download/install/close). Tests mock the
// module so no Tauri IPC ever runs; these fakes mirror the real wire contract.
type PluginDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

interface FakePluginUpdate {
  currentVersion: string
  version: string
  body?: string
  date?: string
  download: (onEvent?: (event: PluginDownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
  close: () => Promise<void>
}

vi.mock("@tauri-apps/plugin-updater", () => ({ check: pluginCheck }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: processRelaunch }))

function fakeUpdate(overrides: Partial<FakePluginUpdate> = {}): FakePluginUpdate {
  return {
    currentVersion: "0.0.1",
    version: "0.1.1",
    body: "Bug fixes and reliability improvements.",
    date: "2026-09-10T10:00:00Z",
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  pluginCheck.mockReset()
  processRelaunch.mockReset()
})

describe("createTauriUpdateAdapter", () => {
  it("resolves null when the plugin reports no update, passing no options", async () => {
    pluginCheck.mockResolvedValueOnce(null)

    await expect(createTauriUpdateAdapter().check()).resolves.toBeNull()
    // No allowDowngrades, headers, or target are ever granted: the endpoint is
    // configured in tauri.conf.json, so the plugin check stays option-free.
    expect(pluginCheck).toHaveBeenCalledWith()
  })

  it("projects plugin metadata onto the adapter update", async () => {
    pluginCheck.mockResolvedValueOnce(fakeUpdate())

    const update = await createTauriUpdateAdapter().check()

    expect(update).not.toBeNull()
    expect(update!.currentVersion).toBe("0.0.1")
    expect(update!.version).toBe("0.1.1")
    expect(update!.notes).toBe("Bug fixes and reliability improvements.")
    expect(update!.publishedAt).toBe("2026-09-10T10:00:00Z")
  })

  it("defaults notes to an empty string when the manifest omits the body", async () => {
    pluginCheck.mockResolvedValueOnce(fakeUpdate({ body: undefined, date: undefined }))

    const update = await createTauriUpdateAdapter().check()

    expect(update!.notes).toBe("")
    expect(update!.publishedAt).toBeUndefined()
  })

  it("maps the Started event with contentLength as the total", async () => {
    const events = await drivePluginDownload({
      event: "Started",
      data: { contentLength: 1024 },
    })

    expect(events).toEqual([{ kind: "started", total: 1024 }])
  })

  it("maps Started with an unknown contentLength to an absent total", async () => {
    const events = await drivePluginDownload({ event: "Started", data: {} })

    expect(events).toEqual([{ kind: "started", total: undefined }])
  })

  it("maps the Progress event with its chunkLength", async () => {
    const events = await drivePluginDownload({
      event: "Progress",
      data: { chunkLength: 42 },
    })

    expect(events).toEqual([{ kind: "progress", chunkLength: 42 }])
  })

  it("maps the Finished event", async () => {
    const events = await drivePluginDownload({ event: "Finished" })

    expect(events).toEqual([{ kind: "finished" }])
  })

  it("resolves when the plugin download completes", async () => {
    pluginCheck.mockResolvedValueOnce(fakeUpdate())

    const update = await createTauriUpdateAdapter().check()
    await expect(update!.download(() => {})).resolves.toBeUndefined()
  })

  it("delegates install to the plugin update handle", async () => {
    const pluginUpdate = fakeUpdate()
    pluginCheck.mockResolvedValueOnce(pluginUpdate)

    const update = await createTauriUpdateAdapter().check()
    await update!.install()

    expect(pluginUpdate.install).toHaveBeenCalledTimes(1)
  })

  it("delegates close to the plugin update handle", async () => {
    const pluginUpdate = fakeUpdate()
    pluginCheck.mockResolvedValueOnce(pluginUpdate)

    const update = await createTauriUpdateAdapter().check()
    await update!.close()

    expect(pluginUpdate.close).toHaveBeenCalledTimes(1)
  })

  it("relaunches through the official process plugin", async () => {
    processRelaunch.mockResolvedValueOnce(undefined)

    await expect(createTauriUpdateAdapter().relaunch()).resolves.toBeUndefined()
    expect(processRelaunch).toHaveBeenCalledTimes(1)
  })
})

/**
 * Runs a plugin download event through the adapter's mapping listener and
 * returns the adapter-level events the coordinator observes.
 */
async function drivePluginDownload(
  pluginEvent: PluginDownloadEvent,
): Promise<AdapterDownloadEvent[]> {
  const viaAdapter: AdapterDownloadEvent[] = []
  const pluginUpdate = fakeUpdate()
  pluginCheck.mockResolvedValueOnce(pluginUpdate)

  const update = await createTauriUpdateAdapter().check()
  if (update === null) throw new Error("expected an available update")

  // The adapter registered its mapping callback as the fake download's only
  // argument; invoke it with the plugin event.
  const downloadPromise = update.download((event) => viaAdapter.push(event))
  const pluginCallback = vi.mocked(pluginUpdate.download).mock.calls[0]![0]
  if (pluginCallback === undefined) throw new Error("no plugin download callback")
  pluginCallback(pluginEvent)
  await downloadPromise
  return viaAdapter
}
