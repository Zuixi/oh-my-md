import { act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { setGlobalLogger, type Logger } from "../src/logger"
import { createAppHarness, resetMountedApps } from "./appHarness"

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
  editor: { create: vi.fn(), reset: vi.fn() },
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

const quietLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  flush: async () => {},
}

function installLogger(flush: Logger["flush"]): void {
  setGlobalLogger({ ...quietLogger, flush })
}

/** A promise the test releases by hand, so "awaited" is distinguishable from
 * "called and forgotten". */
function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

afterEach(() => {
  // The global logger outlives a single test; never leave a spy installed.
  setGlobalLogger(quietLogger)
  resetMountedApps()
})

describe("App quit-time log flush", () => {
  it("flushes queued log records before acknowledging the session flush", async () => {
    const order: string[] = []
    const gate = deferred()
    const flush = vi.fn(() => {
      order.push("logs")
      return gate.promise
    })
    installLogger(flush)

    const harness = createAppHarness(editor)
    harness.services.saveSessionState = vi.fn(async () => { order.push("save") })
    const ack = vi.fn(async () => { order.push("ack") })
    harness.services.sessionFlushAck = ack
    harness.renderApp()

    let pending: Promise<void> | undefined
    await act(async () => {
      pending = harness.triggerSessionFlush()
      await Promise.resolve()
    })

    // The ack is what lets the webview die, so the flush must be *awaited*:
    // nothing may ack while the batch is still in flight.
    expect(order).toEqual(["save", "logs"])
    expect(ack).not.toHaveBeenCalled()

    await act(async () => {
      gate.resolve()
      await pending
    })

    expect(order).toEqual(["save", "logs", "ack"])
  })

  it("still acks when the log flush rejects", async () => {
    installLogger(vi.fn(async () => { throw new Error("ipc down") }))

    const harness = createAppHarness(editor)
    const ack = vi.fn(async () => undefined)
    harness.services.sessionFlushAck = ack
    harness.renderApp()

    await act(async () => { await harness.triggerSessionFlush() })

    expect(ack).toHaveBeenCalledTimes(1)
  })
})
