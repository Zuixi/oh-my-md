import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { createTabLifecycle, type TabLifecycleDeps } from "../src/appTabs"
import { createDocumentMaterializer, type DocumentMaterializer } from "../src/documentMaterializer"
import { createDocumentScaleRegistry } from "../src/documentScaleRegistry"
import { createDocumentStore, type DocumentStore } from "../src/documentStore"
import { MAX_LIVE_EDITOR_VIEWS, createEditorRegistry } from "../src/editorRegistry"
import { createSession, lazyFileSession, type EditorSession } from "../src/session"
import { createWorkspace, type Workspace } from "../src/workspace"
import type { DocumentViews } from "../src/documentViews"
import type { DocumentOpen, OpenTier } from "../src/documentOpen"
import type { TabSaveQueues } from "../src/documentSaveCoordinator"
import type { DesktopServices, DiskSnapshot } from "../src/desktopServices"
import type { CreateEditorOptions } from "../src/Editor"

const SCALE_THRESHOLDS = { safeModeLines: 50_000, safeModeBytes: 8_000_000 }
const MATERIALIZE_MS = 250

// `reviveEvicted` builds a real EditorView through `createEditor`; the lifecycle
// logic under test only needs a view-shaped object in the mounted host.
const editorMock = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("../src/Editor", () => ({
  createEditor: (host: HTMLElement, options: CreateEditorOptions) => editorMock.create(host, options),
}))

function fakeView(text: string): EditorView {
  return {
    state: {
      doc: { length: text.length, toString: () => text },
      selection: { main: { anchor: 0, head: 0 } },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
    scrollDOM: { scrollTop: 0 },
  } as unknown as EditorView
}

function fakeHost(): HTMLDivElement {
  return document.createElement("div")
}

interface Harness {
  readonly lifecycle: ReturnType<typeof createTabLifecycle>
  readonly store: DocumentStore
  readonly registry: ReturnType<typeof createEditorRegistry>
  readonly materializer: DocumentMaterializer
  readonly syncDoc: ReturnType<typeof vi.fn>
  readonly saveRecovery: ReturnType<typeof vi.fn>
  readonly scheduleAutosave: ReturnType<typeof vi.fn>
  readonly refreshOutline: ReturnType<typeof vi.fn>
  readonly open: DocumentOpen
  workspace(): Workspace
  mountView(tabId: number, text: string): EditorView
}

/**
 * Lifecycle harness: the real store/registry/materializer, plus the materialize
 * side effects `documentViews` performs (store sync, recovery write, autosave)
 * collapsed into spies so a tab switch's durability is observable.
 */
function makeHarness(options: {
  tabs?: EditorSession[]
  activeId?: number
  snapshot?: DiskSnapshot
} = {}): Harness {
  const base = createWorkspace()
  const tabs = options.tabs ?? base.tabs
  const workspace: Workspace = {
    tabs,
    activeId: options.activeId ?? tabs[0]!.id,
    nextId: tabs.reduce((max, tab) => Math.max(max, tab.id + 1), base.nextId),
    folder: null,
  }
  const store = createDocumentStore(workspace)
  const registry = createEditorRegistry()
  const syncDoc = vi.fn((value: string, tabId?: number) => {
    store.setTabDoc(tabId ?? store.getWorkspace().activeId, value)
  })
  const saveRecovery = vi.fn()
  const scheduleAutosave = vi.fn()
  const materializer = createDocumentMaterializer({
    delayMs: MATERIALIZE_MS,
    now: () => 0,
    readViewText: tabId => registry.getView(tabId)?.state.doc.toString() ?? null,
    materialize: (tabId, contents) => {
      syncDoc(contents, tabId)
      saveRecovery(tabId, contents)
      scheduleAutosave(tabId)
    },
    setTimer: () => 1,
    clearTimer: vi.fn(),
  })
  const snapshot: DiskSnapshot = options.snapshot ?? {
    kind: "existing",
    requestedPath: "/restored.md",
    contents: "disk contents",
    version: { resolvedPath: "/restored.md", fingerprint: "1" },
  }
  const open = {
    resolveOpenTier: vi.fn(async (): Promise<OpenTier> => "normal"),
    readSnapshotForOpen: vi.fn(async () => snapshot),
    nextRequest: () => 1,
    currentRequest: 1,
  } as unknown as DocumentOpen
  const views = {
    materializer,
    syncDoc,
    jumpPending: () => undefined,
    focusPendingEditor: () => undefined,
    // No view is mounted in these tests: the lazy-load path commits the session
    // and stages the text straight into the store.
    resetTabDocument: () => false,
    editorOptions: (contents: string, tabId: number, documentId: number) => ({
      doc: contents, tabId, documentId,
    }),
  } as unknown as DocumentViews
  const deps: TabLifecycleDeps = {
    services: { allowDocumentAssets: async () => undefined } as unknown as DesktopServices,
    store,
    registry,
    views,
    documentScaleRegistry: createDocumentScaleRegistry(SCALE_THRESHOLDS),
    recoveryWriter: { forget: async () => undefined } as unknown as TabLifecycleDeps["recoveryWriter"],
    tabSaveQueues: new Map() as TabSaveQueues,
    getOpenCoordinator: () => open,
    commitWorkspace: next => store.setWorkspace(next),
    commitNormalization: next => store.setNormalizationByTab(next),
    commitSaveState: next => store.setSaveStateByTab(next),
    invalidateOutline: vi.fn(),
    refreshOutline: vi.fn(),
    applyScalePolicy: vi.fn(),
    reportError: vi.fn(),
    setOpeningLabel: vi.fn(),
    setOpeningProgress: vi.fn(),
    revealFolder: vi.fn(),
    rememberRecent: vi.fn(),
    cancelAutosave: vi.fn(),
  }
  const lifecycle = createTabLifecycle(deps)
  return {
    lifecycle,
    store,
    registry,
    materializer,
    syncDoc,
    saveRecovery,
    scheduleAutosave,
    refreshOutline: deps.refreshOutline as ReturnType<typeof vi.fn>,
    open,
    workspace: () => store.getWorkspace(),
    mountView: (tabId, text) => {
      registry.bindHost(tabId, fakeHost())
      const view = fakeView(text)
      registry.add(tabId, view)
      return view
    },
  }
}

/** Evicts everything but `keepTabId`, leaving the cold tabs with no live view. */
function evictAllBut(harness: Harness, keepTabId: number): void {
  harness.registry.evictOverBudget({
    activeTabId: keepTabId,
    isEvictable: () => true,
    flush: (tabId, contents) => harness.store.setTabDoc(tabId, contents),
    maxLiveViews: 1,
  })
}

describe("live view budget", () => {
  it("evicts after non-activation mounts, not only on tab activation", () => {
    const tabs = Array.from({ length: MAX_LIVE_EDITOR_VIEWS + 2 }, (_, index) => createSession(index + 1))
    const harness = makeHarness({ tabs, activeId: tabs[tabs.length - 1].id })
    for (const tab of tabs) harness.mountView(tab.id, "")
    expect(harness.registry.views().size).toBe(MAX_LIVE_EDITOR_VIEWS + 2)

    harness.lifecycle.evictOverBudget()

    expect(harness.registry.views().size).toBe(MAX_LIVE_EDITOR_VIEWS)
    expect(harness.registry.getView(tabs[tabs.length - 1].id)).toBeDefined()
  })
})

describe("closing the active tab", () => {
  it("revives the LRU-evicted neighbor instead of activating a viewless tab", () => {
    const harness = makeHarness({
      tabs: [createSession(1), createSession(2), createSession(3)],
      activeId: 3,
    })
    harness.store.setTabDoc(2, "text of two")
    harness.mountView(2, "text of two")
    harness.mountView(3, "text of three")
    evictAllBut(harness, 3)
    expect(harness.registry.isEvicted(2)).toBe(true)
    editorMock.create.mockImplementation(() => fakeView("text of two"))
    editorMock.create.mockClear()

    expect(harness.lifecycle.closeTabInternal(3, { confirm: false, allowReplaceLast: true })).toBe(true)

    // `closeTab` slides the next/previous tab into the slot: 2 becomes active.
    expect(harness.workspace().activeId).toBe(2)
    expect(harness.registry.isEvicted(2)).toBe(false)
    expect(harness.registry.getView(2)).toBeDefined()
    expect(editorMock.create).toHaveBeenCalledTimes(1)
    expect(harness.refreshOutline).toHaveBeenCalledWith(harness.registry.getView(2))
    // The neighbor's text survived the close: no empty doc was published over it.
    expect(harness.store.getTabDoc(2)).toBe("text of two")
  })

  it("loads an unloaded lazy neighbor instead of syncing empty text over it", async () => {
    const harness = makeHarness({
      tabs: [createSession(1), lazyFileSession(2, "/restored.md")],
      activeId: 1,
    })
    harness.store.setTabDoc(1, "scratch")

    harness.lifecycle.closeTabInternal(1, { confirm: false, allowReplaceLast: true })

    // Nothing was loaded yet, so the empty store text must not be written over it.
    expect(harness.syncDoc).not.toHaveBeenCalledWith("", 2)
    expect(harness.open.resolveOpenTier).toHaveBeenCalledWith("/restored.md")
    await vi.waitFor(() => {
      expect(harness.store.getTabDoc(2)).toBe("disk contents")
    })
  })
})

describe("switching tabs with unmaterialized edits", () => {
  it("flushes the outgoing tab through the materializer so recovery and autosave stay armed", () => {
    const harness = makeHarness({ tabs: [createSession(1), createSession(2)], activeId: 1 })
    const view = harness.mountView(1, "edited text")
    harness.store.setTabDoc(1, "")
    harness.lifecycle.activateTab(1)
    // A keystroke arrived and is still inside the materialize debounce window.
    harness.store.bumpDocVersion(1)
    harness.materializer.queue(1)
    harness.mountView(2, "second tab")

    harness.lifecycle.activateTab(2)

    expect(harness.store.getTabDoc(1)).toBe("edited text")
    expect(harness.saveRecovery).toHaveBeenCalledWith(1, "edited text")
    expect(harness.scheduleAutosave).toHaveBeenCalledWith(1)
    expect(harness.materializer.hasPending(1)).toBe(false)
    expect(view.state.doc.toString()).toBe("edited text")
  })

  it("does not touch the materializer when the outgoing tab has nothing pending", () => {
    const harness = makeHarness({ tabs: [createSession(1), createSession(2)], activeId: 1 })
    harness.mountView(1, "typed")
    harness.mountView(2, "other")
    harness.store.setTabDoc(1, "stale store copy")

    harness.lifecycle.activateTab(2)

    // No pending edits: the rope is not flattened on every ordinary tab switch.
    expect(harness.saveRecovery).not.toHaveBeenCalled()
    expect(harness.scheduleAutosave).not.toHaveBeenCalled()
    expect(harness.workspace().activeId).toBe(2)
  })
})
