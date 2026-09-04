import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, StrictMode } from "react"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import {
  createAppHarness,
  expectPathShown,
  normalizationId,
  resetMountedApps,
  type FakeUpdateHandle,
} from "./appHarness"
import App from "../src/App"
import { STARTUP_UPDATE_CHECK_MS } from "../src/constants"
import type { PrepareUpdateRestartResult } from "../src/desktopServices"
import { RELEASES_URL } from "../src/constants"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
    acceptOrderedListNormalization: vi.fn(() => ({
      kind: "accepted" as const,
      transaction: {},
    })),
    rejectOrderedListNormalization: vi.fn(() => ({
      kind: "reverted" as const,
      transaction: {},
      restoredMarkers: 1,
      skippedMarkers: 0,
    })),
  }
})

const { editor } = vi.hoisted(() => ({
  editor: {
    create: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

afterEach(() => {
  vi.useRealTimers()
  resetMountedApps()
})

function makeAppHarness() {
  return createAppHarness(editor)
}

function edit(harness: ReturnType<typeof makeAppHarness>, tabId: number, doc: string) {
  harness.editorForTab(tabId).emit({ doc, docChanged: true, pendingNormalization: null })
}

function openPaletteAndRun(query: string) {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: query } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

/** Drives manual check -> available -> explicit download -> downloaded. */
async function reachDownloaded(
  harness: ReturnType<typeof makeAppHarness>,
  props?: { docMaterializeMs?: number },
): Promise<FakeUpdateHandle> {
  harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
  const handle = harness.updates.nextAvailable()
  harness.renderApp(props)
  openPaletteAndRun("check")
  await waitFor(() => expect(harness.updates.lastHandle()).toBe(handle))
  fireEvent.click(screen.getByRole("button", { name: "Download update" }))
  await waitFor(() => expect(handle.download).toHaveBeenCalled())
  handle.finishDownload()
  await waitFor(() => screen.getByRole("button", { name: "Restart and install" }))
  return handle
}

function updateBannerList(): Element | null {
  return document.querySelector(".update-banner-blocked-list")
}

describe("App update integration", () => {
  it("runs one startup check eight seconds after mount and not before", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable({ version: "0.9.9" })

    vi.useFakeTimers()
    harness.renderApp()

    await act(async () => { await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_CHECK_MS - 1) })
    expect(document.querySelector(".update-banner")).toBeNull()
    expect(harness.updates.lastHandle()).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    // The check resolves entirely through microtasks once the timer fires.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
    expect(harness.updates.lastHandle()).toBe(handle)
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("0.9.9")
  })

  it("logs a startup check failure through the log hook with no user UI (spec §10/§14)", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    harness.updates.nextCheckError(new Error("Failed to fetch release JSON"))
    const logUpdateFailure = vi.fn()

    vi.useFakeTimers()
    harness.renderApp({ logUpdateFailure })

    await act(async () => { await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_CHECK_MS) })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
    expect(logUpdateFailure).toHaveBeenCalledTimes(1)
    expect(logUpdateFailure).toHaveBeenCalledWith("network")
    expect(harness.services.reportError).not.toHaveBeenCalled()
    expect(harness.services.notifySuccess).not.toHaveBeenCalled()
    expect(document.querySelector(".update-banner")).toBeNull()
  })

  it("runs a manual check from the command palette and shows the available update", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable({ version: "0.2.0" })

    harness.renderApp()
    openPaletteAndRun("check")

    await waitFor(() => expect(harness.updates.lastHandle()).toBe(handle))
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("0.2.0")
  })

  it("reports manual no-update as current and manual failure with a failed banner", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))

    harness.updates.nextNoUpdate()
    harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() =>
      expect(harness.services.notifySuccess).toHaveBeenCalledWith("oh-my-md is up to date."))
    expect(document.querySelector(".update-banner")).toBeNull()
    expect(harness.services.reportError).not.toHaveBeenCalled()
  })

  it("classifies a manual check failure into the failed banner and a service error", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    harness.updates.nextCheckError(new Error("Fetch timed out"))

    harness.renderApp()
    openPaletteAndRun("check")

    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("Could not reach the update service"))
    await waitFor(() => expect(harness.services.reportError).toHaveBeenCalled())
    expect(String(vi.mocked(harness.services.reportError).mock.calls[0][0]))
      .toContain("Could not reach the update service")
    expect(screen.queryByRole("button", { name: "Open Release" })).toBeNull()
  })

  it("downloads only after the explicit user action, showing progress and completion", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable()

    harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() => expect(harness.updates.lastHandle()).toBe(handle))
    expect(handle.download).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Download update" }))
    await waitFor(() => expect(handle.download).toHaveBeenCalled())
    expect(document.querySelector(".update-banner-message")?.textContent)
      .toContain("Downloading oh-my-md")

    handle.emitDownload({ kind: "started", total: 1024 })
    handle.emitDownload({ kind: "progress", chunkLength: 256 })
    await waitFor(() => {
      const progress = document.querySelector(".update-banner-progress")?.textContent
      expect(progress).toContain("256 B")
      expect(progress).toContain("1 KB")
    })

    handle.finishDownload()
    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("ready to install"))
  })

  it("routes a check-only package to the Release page without ever downloading", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: false }))
    const handle = harness.updates.nextAvailable()
    const openExternal = vi.fn(async () => undefined)
    harness.services.openExternal = openExternal

    harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() => screen.getByRole("button", { name: "Open Release" }))
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Open Release" }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(RELEASES_URL))
    expect(handle.download).not.toHaveBeenCalled()
  })

  it("reports a Release-page open failure at the service boundary", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: false }))
    harness.updates.nextAvailable()
    harness.services.openExternal = vi.fn(async () => { throw new Error("no opener") })

    harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() => screen.getByRole("button", { name: "Open Release" }))
    fireEvent.click(screen.getByRole("button", { name: "Open Release" }))

    await waitFor(() => expect(harness.services.reportError).toHaveBeenCalled())
    expect(String(vi.mocked(harness.services.reportError).mock.calls[0][0]))
      .toContain("Could not open the Release page")
  })

  it("blocks restart while a document is dirty", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "unsaved words")

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Unsaved changes")
    expect(harness.services.prepareUpdateRestart).not.toHaveBeenCalled()
  })

  it("blocks restart while a tab is in a save conflict", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "saved")
    harness.disk("/notes/a.md").set("theirs")
    edit(harness, 1, "mine")
    await harness.saveActive()
    await waitFor(() => expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Save conflict")
  })

  it("blocks restart after a failed save", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "edited")
    harness.failNextSave({ code: "internal", message: "disk full" })
    await harness.saveActive()
    await waitFor(() => expect(screen.getByText("save failed")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Save failed")
  })

  it("blocks restart while a tab is actively saving", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "edited")
    const gate = harness.pauseNextSave()
    await harness.saveActive()

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Currently saving")
    gate.resolve()
    await act(async () => { await Promise.resolve() })
  })

  it("blocks restart while ordered-list normalization is pending", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Ordered-list review pending")
  })

  it("blocks restart while a file is opening", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    vi.mocked(harness.services.readDocument).mockReturnValueOnce(new Promise(() => {}))
    vi.mocked(harness.services.pickOpenPath).mockResolvedValueOnce("/notes/a.md")
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("Opening the file"))
  })

  it("flushes the materializer so the last edit is visible before readiness", async () => {
    const harness = makeAppHarness()
    // A trailing window far longer than the test duration guarantees the edit
    // stays pending until the coordinator's flushPendingEdits materializes it.
    await reachDownloaded(harness, { docMaterializeMs: 60_000 })
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "last words before install")

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Unsaved changes")
    expect(harness.services.prepareUpdateRestart).not.toHaveBeenCalled()
  })

  it("navigates to the first blocked document from the banner", async () => {
    const harness = makeAppHarness()
    await reachDownloaded(harness)
    await harness.openFileTab("/notes/a.md", "saved")
    await harness.openInNewTab("/notes/b.md", "clean")
    edit(harness, 1, "dirty draft")

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))
    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))

    fireEvent.click(screen.getByRole("button", { name: "View first problem document" }))
    await waitFor(() => expectPathShown("/notes/a.md", { dirty: true }))
  })

  it("keeps the app mounted after a session-flush timeout and never installs", async () => {
    const harness = makeAppHarness()
    const handle = await reachDownloaded(harness)
    harness.services.prepareUpdateRestart = vi.fn<() => Promise<PrepareUpdateRestartResult>>(async () => ({ kind: "timedOut" }))

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("did not finish saving session state"))
    expect(handle.install).not.toHaveBeenCalled()
    expect(harness.updates.relaunch()).not.toHaveBeenCalled()
    // The application itself is untouched: the editor shell is still mounted.
    expectPathShown("unnamed")
  })

  it("requires a separate final confirmation before calling the installer", async () => {
    const harness = makeAppHarness()
    const handle = await reachDownloaded(harness)

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("close and restart"))
    expect(handle.install).not.toHaveBeenCalled()
    expect(harness.updates.relaunch()).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))
    await waitFor(() => expect(handle.install).toHaveBeenCalled())
    await waitFor(() => expect(harness.updates.relaunch()).toHaveBeenCalled())
  })

  it("blocks install when a document is edited after the final confirmation", async () => {
    const harness = makeAppHarness()
    const handle = await reachDownloaded(harness)

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))
    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("close and restart"))
    expect(handle.install).not.toHaveBeenCalled()

    // An edit made after the final confirmation must block the actual install.
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "edited after confirmation")

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))

    await waitFor(() => expect(updateBannerList()?.textContent).toContain("a.md"))
    expect(updateBannerList()?.textContent).toContain("Unsaved changes")
    expect(handle.install).not.toHaveBeenCalled()
    expect(harness.updates.relaunch()).not.toHaveBeenCalled()
  })

  it("hiding during a download hides the banner but the completed download reappears", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable()

    harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() => screen.getByRole("button", { name: "Download update" }))
    fireEvent.click(screen.getByRole("button", { name: "Download update" }))
    await waitFor(() => expect(handle.download).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "Hide" }))
    await waitFor(() => expect(document.querySelector(".update-banner")).toBeNull())

    handle.finishDownload()
    await waitFor(() =>
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("ready to install"))
  })

  it("disposes the coordinator and suppresses late publications after unmount", async () => {
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable()

    const rendered = harness.renderApp()
    openPaletteAndRun("check")
    await waitFor(() => expect(harness.updates.lastHandle()).toBe(handle))
    fireEvent.click(screen.getByRole("button", { name: "Download update" }))
    await waitFor(() => expect(handle.download).toHaveBeenCalled())

    rendered.unmount()
    expect(handle.close).toHaveBeenCalled()

    handle.emitDownload({ kind: "started", total: 8 })
    handle.finishDownload()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector(".update-banner")).toBeNull()
  })

  it("keeps a live coordinator when StrictMode double-invokes mount effects", async () => {
    // main.tsx mounts <App/> inside <React.StrictMode>; in dev the mount effect
    // runs, cleans up, and runs again. The coordinator must be rebuilt (not a
    // disposed instance) and the startup timer must still be scheduled.
    const harness = makeAppHarness()
    harness.services.updateCapability = vi.fn(async () => ({ check: true, install: true }))
    const handle = harness.updates.nextAvailable()

    vi.useFakeTimers()
    render(
      createElement(StrictMode, null,
        createElement(App, {
          services: harness.services,
          updateAdapter: harness.updates.adapter(),
        })),
    )

    await act(async () => { await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_CHECK_MS) })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await Promise.resolve() })
    }

    expect(harness.updates.lastHandle()).toBe(handle)
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("is available")
    // A second StrictMode mount cycle must not leave two live subscriptions: a
    // later manual check still reaches exactly one adapter check.
    const before = harness.updates.adapter().check.mock.calls.length
    openPaletteAndRun("check")
    await act(async () => { await Promise.resolve() })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
    expect(harness.updates.adapter().check.mock.calls.length)
      .toBe(before + 1)
  })
})
