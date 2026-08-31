# Desktop Editor Status and App Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-keystroke App-shell renders while preserving immediate editor status, then extract the directly affected App workflows behind focused desktop modules.

**Architecture:** CodeMirror remains the immediate document truth. A small external status store drives only `StatusBar`, while document materialization keeps its existing trailing timer. Follow-up extractions move materialization, workspace search, and scale metadata into typed desktop-owned modules without adding a state-management dependency.

**Tech Stack:** React 19, `useSyncExternalStore`, TypeScript, CodeMirror 6, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`

## Global Constraints

- Do not add Redux, Zustand, or another state-management dependency.
- CodeMirror remains the immediate document truth; React receives trailing materialized text.
- Stale tab/document/view identities must not update active status or document state.
- Keep window-level listeners stable and preserve existing save, recovery, outline, normalization, and large-document behavior.
- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`.
- User-visible failures continue through `services.reportError`; do not add `window.alert`.
- Use strict TypeScript and named exports; `App.tsx` remains the default-export exception.
- Do not edit unrelated untracked table-editing documents.

---

### Task 1: Add the editor-status store

**Files:**
- Create: `apps/desktop/src/editorStatusStore.ts`
- Create: `apps/desktop/test/editorStatusStore.test.tsx`

**Interfaces:**
- Consumes: `EditorStatus` from `apps/desktop/src/Editor.ts`.
- Produces:

```ts
export interface EditorStatusStore {
  getSnapshot(): EditorStatus
  subscribe(listener: () => void): () => void
  publish(next: EditorStatus): void
}

export function createEditorStatusStore(initial?: EditorStatus): EditorStatusStore
export function useEditorStatus(store: EditorStatusStore): EditorStatus
```

- [ ] **Step 1: Write the failing store and subscription tests**

```tsx
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createEditorStatusStore, useEditorStatus } from "../src/editorStatusStore"

describe("editor status store", () => {
  it("notifies only when cursor or mode changes", () => {
    const store = createEditorStatusStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.publish({ cursor: "1:1", mode: "live" })
    expect(listener).not.toHaveBeenCalled()

    store.publish({ cursor: "2:3", mode: "live" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({ cursor: "2:3", mode: "live" })

    unsubscribe()
    store.publish({ cursor: "2:3", mode: "source" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("updates only consumers subscribed through the hook", () => {
    const store = createEditorStatusStore()
    const { result } = renderHook(() => useEditorStatus(store))
    act(() => store.publish({ cursor: "9:4", mode: "source" }))
    expect(result.current).toEqual({ cursor: "9:4", mode: "source" })
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```sh
pnpm --filter @omd/desktop test -- editorStatusStore.test.tsx
```

Expected: FAIL because `../src/editorStatusStore` does not exist.

- [ ] **Step 3: Implement the minimal stable store**

```ts
import { useSyncExternalStore } from "react"
import type { EditorStatus } from "./Editor"

const DEFAULT_STATUS: EditorStatus = { cursor: "1:1", mode: "live" }

export interface EditorStatusStore {
  getSnapshot(): EditorStatus
  subscribe(listener: () => void): () => void
  publish(next: EditorStatus): void
}

export function createEditorStatusStore(
  initial: EditorStatus = DEFAULT_STATUS,
): EditorStatusStore {
  let snapshot = initial
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: next => {
      if (next.cursor === snapshot.cursor && next.mode === snapshot.mode) return
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

export function useEditorStatus(store: EditorStatusStore): EditorStatus {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
```

- [ ] **Step 4: Run the focused test**

Run:

```sh
pnpm --filter @omd/desktop test -- editorStatusStore.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/editorStatusStore.ts apps/desktop/test/editorStatusStore.test.tsx
git commit -m "perf: isolate editor status subscriptions"
```

### Task 2: Report status from Editor without changing document payloads

**Files:**
- Modify: `apps/desktop/src/Editor.ts:28-55,138-201`
- Modify: `apps/desktop/test/Editor.test.ts:24-90,130-155`

**Interfaces:**
- Consumes: `EditorStatus` and existing `CreateEditorOptions`.
- Produces: optional callback:

```ts
readonly onStatusChange?: (status: EditorStatus) => void
```

- [ ] **Step 1: Add failing Editor callback tests**

Add to `Editor.test.ts`:

```ts
it("reports cursor and mode without adding document text to update payloads", () => {
  const onDocumentUpdate = vi.fn()
  const onStatusChange = vi.fn()
  const view = createEditor(document.createElement("div"), {
    ...editorOptions(onDocumentUpdate, "# Title\nbody"),
    onStatusChange,
  })

  onStatusChange.mockClear()
  view.dispatch({ selection: { anchor: 9 } })

  expect(onDocumentUpdate).not.toHaveBeenCalled()
  expect(onStatusChange).toHaveBeenLastCalledWith({ cursor: "2:2", mode: "live" })
  view.destroy()
})

it("deduplicates unchanged status snapshots", () => {
  const onStatusChange = vi.fn()
  const view = createEditor(document.createElement("div"), {
    ...editorOptions(vi.fn(), "body"),
    onStatusChange,
  })

  onStatusChange.mockClear()
  view.dispatch({ annotations: [] })
  expect(onStatusChange).not.toHaveBeenCalled()
  view.destroy()
})
```

- [ ] **Step 2: Run the Editor tests and verify failure**

Run:

```sh
pnpm --filter @omd/desktop test -- Editor.test.ts
```

Expected: FAIL because `CreateEditorOptions` has no `onStatusChange` behavior.

- [ ] **Step 3: Add the callback and a per-binding dedupe closure**

Add the option:

```ts
readonly onStatusChange?: (status: EditorStatus) => void
```

Create a reporter when building editor state:

```ts
function createStatusReporter(options: CreateEditorOptions) {
  let previous: EditorStatus | null = null
  return (view: EditorView) => {
    if (!options.onStatusChange) return
    const next = editorStatus(view)
    if (previous?.cursor === next.cursor && previous.mode === next.mode) return
    previous = next
    options.onStatusChange(next)
  }
}
```

Inside `createEditorState`, instantiate it once and call it from the update listener:

```ts
const reportStatus = createStatusReporter(options)

EditorView.updateListener.of(update => {
  reportEditorUpdate(options, update)
  reportModeChange(options, update)
  reportStatus(update.view)
})
```

Do not put document text in `EditorDocumentUpdate`.

- [ ] **Step 4: Run focused Editor tests**

Run:

```sh
pnpm --filter @omd/desktop test -- Editor.test.ts
```

Expected: PASS, including the existing selection-only `onDocumentUpdate` test.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/Editor.ts apps/desktop/test/Editor.test.ts
git commit -m "perf: publish lightweight editor status"
```

### Task 3: Wire StatusBar directly and remove per-keystroke App state

**Files:**
- Modify: `apps/desktop/src/StatusBar.tsx:1-45`
- Modify: `apps/desktop/src/App.tsx:277-370,659-677,690-720,2040-2070,2227-2250,2545-2555`
- Modify: `apps/desktop/test/App.docMaterialize.test.tsx`
- Create: `apps/desktop/test/App.editorStatusRender.test.tsx`

**Interfaces:**
- Consumes: `EditorStatusStore`, `useEditorStatus`, and Editor `onStatusChange`.
- Produces: `StatusBar` prop `statusStore: EditorStatusStore` in place of
  separate `cursor` and `mode` props.

- [ ] **Step 1: Write the failing App render-boundary test**

Create a test that counts `TopBar` renders while keeping the real StatusBar:

```tsx
import { act, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

const { editor, topBarRender } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
  topBarRender: vi.fn(),
}))

vi.mock("../src/TopBar", () => ({
  TopBar: (props: { filePath: string | null }) => {
    topBarRender(props.filePath)
    return <div data-testid="topbar-probe" />
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

afterEach(() => resetMountedApps())

describe("editor status render boundary", () => {
  it("updates StatusBar without rerendering the App shell", async () => {
    vi.useFakeTimers()
    try {
      const harness = createAppHarness(editor)
      harness.renderApp({ docMaterializeMs: 250 })
      const before = topBarRender.mock.calls.length
      const handle = harness.editorForTab(1)

      act(() => handle.getOptions().onStatusChange?.({ cursor: "4:2", mode: "source" }))
      expect(screen.getByText("4:2")).toBeTruthy()
      expect(screen.getByText("source")).toBeTruthy()
      expect(topBarRender).toHaveBeenCalledTimes(before)

      handle.emit({ doc: "typed", docChanged: true, pendingNormalization: null })
      expect(topBarRender).toHaveBeenCalledTimes(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: Run the test and verify current behavior fails**

Run:

```sh
pnpm --filter @omd/desktop test -- App.editorStatusRender.test.tsx
```

Expected: FAIL because App still increments `docVersion`, and StatusBar does not
subscribe to the new store.

- [ ] **Step 3: Make StatusBar subscribe to the store**

Replace cursor/mode props with:

```ts
import { useEditorStatus, type EditorStatusStore } from "./editorStatusStore"

export function StatusBar(props: {
  statusStore: EditorStatusStore
  stats: { words: number; chars: number } | null
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
  onRequestStats?: () => void
}) {
  const t = useT()
  const { cursor, mode } = useEditorStatus(props.statusStore)
  // render existing markup using cursor and mode
}
```

- [ ] **Step 4: Wire one stable store in App**

Create it once:

```ts
const [editorStatusStore] = useState(createEditorStatusStore)
```

In `editorOptions`, publish only for the bound active identity:

```ts
onStatusChange: status => {
  const tab = tabById(tabId)
  if (!tab || tab.documentId !== documentId) return
  if (workspaceRef.current.activeId !== tabId) return
  editorStatusStore.publish(status)
},
```

Publish after active-tab changes and resets:

```ts
editorStatusStore.publish(editorStatus(viewRef.current))
```

Pass the store:

```tsx
<StatusBar
  statusStore={editorStatusStore}
  stats={stats}
  normalizationReviewRequired={bannerKind === "normalization"}
  saveStatus={saveStatusLabel(activeSaveState)}
  onRequestStats={safeModeActive ? () => setStatsRequested(n => n + 1) : undefined}
/>
```

- [ ] **Step 5: Remove the dummy per-keystroke state**

Delete:

```ts
const [, setDocVersion] = useState(0)
```

Delete from `handleDocumentUpdate`:

```ts
setDocVersion(v => v + 1)
```

Remove the render-time:

```ts
const { cursor, mode } = editorStatus(viewRef.current)
```

Keep the existing materialization queue and normalization projection unchanged.

- [ ] **Step 6: Run the focused App tests**

Run:

```sh
pnpm --filter @omd/desktop test -- \
  App.editorStatusRender.test.tsx \
  App.docMaterialize.test.tsx \
  App.stats.test.tsx \
  App.largeDoc.test.tsx \
  App.outlineCache.test.tsx
```

Expected: PASS. The render-boundary test proves TopBar does not rerender before
the materialization timer, while StatusBar updates immediately.

- [ ] **Step 7: Commit**

```sh
git add apps/desktop/src/App.tsx apps/desktop/src/StatusBar.tsx \
  apps/desktop/test/App.editorStatusRender.test.tsx \
  apps/desktop/test/App.docMaterialize.test.tsx
git commit -m "perf: stop rerendering app on every edit"
```

### Task 4: Extract trailing document materialization

**Files:**
- Create: `apps/desktop/src/documentMaterializer.ts`
- Create: `apps/desktop/test/documentMaterializer.test.ts`
- Modify: `apps/desktop/src/App.tsx:343-345,490-513,629-675,790-792,918-920,1404-1406,1536-1541,1649-1652,1665-1667,1926-1929`

**Interfaces:**
- Produces:

```ts
export interface DocumentMaterializer {
  queue(tabId: number): void
  flush(): void
  flushTab(tabId: number): void
  discard(tabId: number): void
  hasPending(tabId: number): boolean
  destroy(): void
}

export function createDocumentMaterializer(deps: {
  delayMs: number
  readViewText(tabId: number): string | null
  materialize(tabId: number, contents: string): void
  setTimer(callback: () => void, ms: number): number
  clearTimer(id: number): void
}): DocumentMaterializer
```

- [ ] **Step 1: Write failing pure coordinator tests**

```ts
import { describe, expect, it, vi } from "vitest"
import { createDocumentMaterializer } from "../src/documentMaterializer"

describe("document materializer", () => {
  it("coalesces queued tabs and materializes latest text once", () => {
    const callbacks = new Map<number, () => void>()
    let timerId = 0
    const text = new Map([[1, "latest"]])
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: id => text.get(id) ?? null,
      materialize,
      setTimer: callback => {
        callbacks.set(++timerId, callback)
        return timerId
      },
      clearTimer: id => { callbacks.delete(id) },
    })

    subject.queue(1)
    subject.queue(1)
    expect(callbacks.size).toBe(1)
    callbacks.values().next().value?.()
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize).toHaveBeenCalledWith(1, "latest")
  })

  it("flushes and discards individual tabs safely", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: id => `doc-${id}`,
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.queue(1)
    subject.queue(2)
    subject.discard(2)
    subject.flushTab(1)
    expect(materialize).toHaveBeenCalledWith(1, "doc-1")
    expect(materialize).not.toHaveBeenCalledWith(2, "doc-2")
  })
})
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```sh
pnpm --filter @omd/desktop test -- documentMaterializer.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the coordinator**

Use one pending set and one trailing timer. `delayMs === 0` calls `flush()`
synchronously. `flushTab` removes and materializes one tab without flushing
unrelated tabs. `destroy` clears the timer and pending set. A missing view text
removes the pending entry without calling `materialize`.

- [ ] **Step 4: Replace App-owned timer/set operations**

Create one stable materializer with dependencies reading the existing refs:

```ts
const materializerRef = useRef<DocumentMaterializer | null>(null)
if (!materializerRef.current) {
  materializerRef.current = createDocumentMaterializer({
    delayMs: docMaterializeMs,
    readViewText: tabId => viewsRef.current.get(tabId)?.state.doc.toString() ?? null,
    materialize: (tabId, contents) => {
      syncDoc(contents, tabId)
      const tab = workspaceRef.current.tabs.find(item => item.id === tabId)
      if (tab) saveRecovery(tab, contents)
    },
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: id => window.clearTimeout(id),
  })
}
```

Use `queue`, `flush`, `flushTab`, `discard`, and `hasPending` at every current
`pendingDocTabsRef` call site. Call `destroy()` during App cleanup.

If tests configure different `docMaterializeMs` per mount, the materializer is
created per App mount; do not add runtime delay mutation.

- [ ] **Step 5: Run materialization and lifecycle tests**

Run:

```sh
pnpm --filter @omd/desktop test -- \
  documentMaterializer.test.ts \
  App.docMaterialize.test.tsx \
  App.closeLast.test.tsx \
  App.sessionFlush.test.tsx \
  App.settingsAndSession.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/documentMaterializer.ts apps/desktop/src/App.tsx \
  apps/desktop/test/documentMaterializer.test.ts
git commit -m "refactor: isolate document materialization"
```

### Task 5: Extract debounced workspace search state

**Files:**
- Create: `apps/desktop/src/useWorkspaceSearch.ts`
- Create: `apps/desktop/test/useWorkspaceSearch.test.tsx`
- Modify: `apps/desktop/src/App.tsx:390-397,2167,2212-2225,2334-2347`

**Interfaces:**
- Produces:

```ts
export interface WorkspaceSearchState {
  open: boolean
  query: string
  hits: SearchHit[]
  truncated: boolean
  caseSensitive: boolean
  setOpen(open: boolean): void
  setQuery(query: string): void
  setCaseSensitive(caseSensitive: boolean): void
  clear(): void
}

export function useWorkspaceSearch(options: {
  folder: string | null
  search?: (root: string, query: string, caseSensitive: boolean) => Promise<SearchResponse>
  reportError(error: unknown): void
  debounceMs: number
}): WorkspaceSearchState
```

- [ ] **Step 1: Write failing hook tests**

Test debounce, stale request suppression, close/empty-query clearing, and error
reporting:

```tsx
it("keeps only the newest request result", async () => {
  vi.useFakeTimers()
  const first = deferred<SearchResponse>()
  const second = deferred<SearchResponse>()
  const search = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const { result } = renderHook(() => useWorkspaceSearch({
    folder: "/notes",
    search,
    reportError: vi.fn(),
    debounceMs: 200,
  }))

  act(() => {
    result.current.setOpen(true)
    result.current.setQuery("a")
    vi.advanceTimersByTime(200)
    result.current.setQuery("b")
    vi.advanceTimersByTime(200)
  })
  await act(async () => {
    second.resolve({ hits: [hit("new")], truncated: false })
    first.resolve({ hits: [hit("old")], truncated: false })
  })
  expect(result.current.hits.map(item => item.text)).toEqual(["new"])
})
```

- [ ] **Step 2: Run the hook tests and verify failure**

Run:

```sh
pnpm --filter @omd/desktop test -- useWorkspaceSearch.test.tsx
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the hook with a generation counter**

Use local React state and:

```ts
const requestRef = useRef(0)
const reportErrorRef = useRef(reportError)
reportErrorRef.current = reportError

useEffect(() => {
  if (!open || !folder || query === "" || !search) {
    setHits([])
    setTruncated(false)
    return
  }
  const request = ++requestRef.current
  const timer = window.setTimeout(() => {
    void search(folder, query, caseSensitive).then(response => {
      if (requestRef.current !== request) return
      setHits(response.hits)
      setTruncated(response.truncated)
    }).catch(error => {
      if (requestRef.current === request) reportErrorRef.current(error)
    })
  }, debounceMs)
  return () => window.clearTimeout(timer)
}, [open, folder, query, caseSensitive, search, debounceMs])
```

`clear()` increments the request generation and resets query/results.

- [ ] **Step 4: Wire App and remove duplicated state/effect**

Use the hook once, map its values to `SearchPanel`, and keep
`searchOpenRef.current = search.open` for the native watcher callback.

- [ ] **Step 5: Run search and App integration tests**

Run:

```sh
pnpm --filter @omd/desktop test -- \
  useWorkspaceSearch.test.tsx \
  App.test.tsx \
  App.watchEvents.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/useWorkspaceSearch.ts apps/desktop/src/App.tsx \
  apps/desktop/test/useWorkspaceSearch.test.tsx
git commit -m "refactor: isolate workspace search state"
```

### Task 6: Extract document-scale metadata and remove dead choice state

**Files:**
- Create: `apps/desktop/src/documentScaleRegistry.ts`
- Create: `apps/desktop/test/documentScaleRegistry.test.ts`
- Modify: `apps/desktop/src/App.tsx:350-370,651-656,703-756,789-790,823,853-864,935,1025,1212,1371-1384,1584-1590,1642-1654,1854,2237-2240`

**Interfaces:**
- Produces:

```ts
export interface DocumentScaleRegistry {
  setBytes(tabId: number, bytes: number | undefined): void
  setReadOnly(tabId: number, readOnly: boolean): void
  stashText(tabId: number, text: Text): void
  takeText(tabId: number): Text | undefined
  isReadOnly(tabId: number): boolean
  isSafeMode(tabId: number): boolean
  classify(tabId: number, lines: number): { safeMode: boolean; readOnly: boolean }
  applyRenderPolicy(tabId: number): void
  remove(tabId: number): void
}
```

- [ ] **Step 1: Write failing registry tests**

Cover byte and line thresholds, read-only implication, one-shot `Text`
consumption, cleanup, and calls to injected render-policy setters.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```sh
pnpm --filter @omd/desktop test -- documentScaleRegistry.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a registry with injected thresholds and engine setters**

The production factory receives:

```ts
{
  safeModeLines: SAFE_MODE_LINES,
  safeModeBytes: SAFE_MODE_BYTES,
  renderBudgetLines: SAFE_MODE_RENDER_BUDGET_LINES,
  setRenderBudget: setBlockRenderBudget,
  setSafeModeRendering,
}
```

`classify` updates the safe-mode set from current lines/bytes/read-only state.
`applyRenderPolicy` sets the process-global engine flags for the requested tab.

- [ ] **Step 4: Replace App's scale sets/maps**

Replace `safeModeTabsRef`, `docBytesRef`, `docTextsRef`, and
`readonlyTabsRef` with one stable registry. Preserve the invariant that only
the active tab applies process-global engine render settings.

Delete `safeModeChoiceRef`: the current code records additions/deletions but
does not read it to drive behavior. Update tests that referenced the obsolete
historical choice.

- [ ] **Step 5: Run all large-document tests**

Run:

```sh
pnpm --filter @omd/desktop test -- \
  documentScaleRegistry.test.ts \
  App.largeDoc.test.tsx \
  App.largeDocOpen.test.tsx \
  App.outlineCache.test.tsx \
  App.settingsAndSession.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Update the stable desktop rule**

Add to `apps/desktop/AGENTS.md`:

```md
- Editor cursor/mode status is published through the dedicated editor-status
  store so CodeMirror updates rerender `StatusBar`, not the App shell. Document
  text still enters React only through the trailing materializer.
```

- [ ] **Step 7: Run the complete desktop suite and build**

Run:

```sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: both commands PASS.

- [ ] **Step 8: Commit**

```sh
git add apps/desktop/src/documentScaleRegistry.ts apps/desktop/src/App.tsx \
  apps/desktop/test/documentScaleRegistry.test.ts apps/desktop/AGENTS.md
git commit -m "refactor: centralize document scale policy"
```
