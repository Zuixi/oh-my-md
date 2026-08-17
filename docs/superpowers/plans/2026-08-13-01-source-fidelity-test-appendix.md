# Source Fidelity Test Appendix

**Plan:** `docs/superpowers/plans/2026-08-13-01-source-fidelity.md`

This appendix contains executable test shapes referenced by Tasks 1, 2, 4, 5, 6, and 7. Implementers must preserve the assertions when adapting imports or existing harness setup.

## Engine command completion

Task 1 adds the accepted path, not only stale handling:

```ts
it("accepts the matching pending id without changing source", async () => {
  const { view } = makeView("1. a\n3. b")
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  const before = view.state.doc.toString()
  const result = acceptOrderedListNormalization(view.state, notice.id)
  expect(result.kind).toBe("accepted")
  if (result.kind === "accepted") view.dispatch(result.transaction)
  expect(view.state.doc.toString()).toBe(before)
  expect(getPendingOrderedListNormalization(view.state)).toBeNull()
  view.destroy()
})
```

## Engine mode, mapping, and parse-progress cases

Task 2 uses Source mode for a reachable skipped-marker case:

```ts
it("skips a pending marker edited in source mode", async () => {
  const { view } = makeView("1. a\n3. b")
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  view.dispatch(applyToggle(view.state))
  const line = view.state.doc.line(2)
  view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "9." } })
  const result = rejectOrderedListNormalization(view.state, notice.id)
  expect(result.kind === "reverted" && result.skippedMarkers).toBe(1)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  expect(view.state.doc.line(2).text).toBe("9. b")
  view.destroy()
})
```

Pending/suppression survives mode toggles:

```ts
it("keeps pending and suppression across source/live toggles", async () => {
  const { view } = makeView("1. a\n3. b")
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  view.dispatch(applyToggle(view.state))
  expect(getPendingOrderedListNormalization(view.state)?.id).toBe(notice.id)
  const rejected = rejectOrderedListNormalization(view.state, notice.id)
  if (rejected.kind === "reverted") view.dispatch(rejected.transaction)
  view.dispatch(applyToggle(view.state))
  await tick()
  expect(view.state.doc.toString()).toBe("1. a\n3. b")
  expect(getPendingOrderedListNormalization(view.state)).toBeNull()
  view.destroy()
})
```

Directly test the module-internal merge helper:

```ts
it("keeps first original and latest normalized for a repeated marker", () => {
  const first = [{ from: 5, to: 7, original: "3.", normalized: "2." }]
  const second = [{ from: 5, to: 7, original: "2.", normalized: "4." }]
  expect(mergeReversibleOrderedMarkers(first, second)).toEqual([
    { from: 5, to: 7, original: "3.", normalized: "4." },
  ])
})
```

Range mapping must use `from` assoc `1` and `to` assoc `-1`. Add three cases:

```ts
it.each([
  ["before", { from: 5, insert: "x" }, { from: 6, to: 8 }],
  ["inside", { from: 6, insert: "x" }, { from: 5, to: 8 }],
  ["after", { from: 7, insert: "x" }, { from: 5, to: 7 }],
])("maps %s insertion without widening the wrong boundary", (_name, change, expected) => {
  expect(mapReversibleMarkerRange(
    { from: 5, to: 7, original: "3.", normalized: "2." },
    ChangeSet.of([change], 12),
  )).toMatchObject(expected)
})
```

Add explicit named cases:

- `does not create pending for already-consecutive numbers`
- `does not create pending in source mode`
- `does not extend pending with new user-followup markers`
- `updates latest normalized for a user-followup rewrite of an existing pending marker`
- `keeps tree-progress batches in preview-entry until the syntax tree covers the document`
- `skips normalization while composing`
- `keeps consecutive preview labels after source markers are restored`

The parse-progress test injects a classification helper with `treeLength < docLength`, then asserts the returned trigger is `preview-entry` even after `hasUserDocChange` becomes true.

Two-batch and rendering guards:

```ts
it("merges two preview batches under one id and restores every marker", async () => {
  const { view } = makeView("1. a\n3. b\n7. c")
  await dispatchPreviewBatch(view, [{ from: 5, to: 7, insert: "2." }])
  const first = getPendingOrderedListNormalization(view.state)!
  await dispatchPreviewBatch(view, [{ from: 10, to: 12, insert: "3." }])
  const second = getPendingOrderedListNormalization(view.state)!
  expect(second).toEqual({ id: first.id, markerCount: 2 })
  const result = rejectOrderedListNormalization(view.state, second.id)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  expect(view.state.doc.toString()).toBe("1. a\n3. b\n7. c")
})

it("keeps consecutive preview labels after reject", async () => {
  const { view } = makeView("1. a\n3. b\n\ntail")
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  const result = rejectOrderedListNormalization(view.state, notice.id)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  expect(view.state.doc.toString()).toBe("1. a\n3. b\n\ntail")
  expect(view.dom.querySelectorAll(".omd-ordered-mark")[1]?.textContent).toBe("2.")
})

it("does not normalize while the view is composing", async () => {
  const { view } = makeView("1. a\n3. b")
  Object.defineProperty(view, "composing", { configurable: true, value: true })
  await tick()
  expect(view.state.doc.toString()).toBe("1. a\n3. b")
  expect(getPendingOrderedListNormalization(view.state)).toBeNull()
})
```

`dispatchPreviewBatch` calls the module-internal builder without exposing private annotations:

```ts
function dispatchPreviewBatch(view: EditorView, changes: readonly OrderedMarkChange[]) {
  view.dispatch(buildOrderedNormalizationTransaction(view.state, "preview-entry", changes))
}
```

The builder is exported from `lists/ordered.ts` for direct module tests but not re-exported from the package index.

## Desktop App test harness contract

Create `apps/desktop/test/appHarness.ts` so App integration tests do not share one fake view:

```ts
export interface FakeEditorHandle {
  readonly view: EditorView
  getOptions: () => CreateEditorOptions
  setContents: (contents: string) => void
  emit: (update: Omit<EditorDocumentUpdate, "tabId" | "documentId">) => void
}

type HarnessServices = DesktopServices & Required<
  Pick<DesktopServices, "writeRecovery" | "confirmClose" | "confirmExternalChange">
>

export interface AppHarness {
  readonly services: HarnessServices
  renderApp: (props?: { autosaveMs?: number; watchMs?: number }) => RenderResult
  editorForTab: (tabId: number) => FakeEditorHandle
  allEditors: () => readonly FakeEditorHandle[]
  activateTab: (tabId: number) => void
  openIntoActive: (path: string, contents: string) => Promise<void>
  openInNewTab: (path: string, contents: string) => Promise<void>
  requestOpen: (path: string, contents: string) => Promise<void>
  emitPending: (tabId: number, id: NormalizationId) => void
  saveNormalization: (tabId: number) => Promise<void>
  failNextReset: (error: Error) => void
  requestCloseTab: (tabId: number) => void
  runExternalCheck: () => Promise<void>
}
```

Use one branded test helper everywhere:

```ts
export function normalizationId(value: number): NormalizationId {
  return value as NormalizationId
}
```

Each `editor.create` call constructs a distinct fake object with:

```ts
const view = {
  state: { doc: { toString: () => contents } },
  dispatch: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
} as unknown as EditorView
```

`emit` always injects the options-bound tabId/documentId. This makes wrong-view dispatch and background-tab routing observable.

`emit` first replaces that handle’s `contents`, so fake view text and callback `doc` stay identical. `emitPending(tabId, id)` emits a real normalized doc change (`docChanged: true`) and updates both contents and the per-view pending map. Tests needing a pending-only transition call `handle.emit(...)` directly with `docChanged: false`.

Keep `vi.mock("../src/Editor", ...)` and `vi.mock("@omd/engine", ...)` at the top level of `App.test.tsx`, where Vitest can hoist them. `appHarness.ts` receives the hoisted editor mock object; it must not declare those module mocks itself.

Store pending notices in a `Map<EditorView, OrderedListNormalizationNotice | null>`. The hoisted `getPendingOrderedListNormalization` mock resolves by the state/view pair owned by each fake handle. `emitPending(tabId, id)` updates that map before emitting the UI projection. `saveNormalization(tabId)` activates the tab before clicking its active-only banner.

Harness defaults provide spies for `writeRecovery` and `confirmClose`, even though both are optional in production. `confirmClose` and required `confirmDiscard` return `true` unless a test overrides them.

## Editor contract tests

Selection-only updates remain silent:

```ts
it("ignores selection-only updates when pending is unchanged", () => {
  const onDocumentUpdate = vi.fn()
  const view = createEditor(document.createElement("div"), editorOptions(onDocumentUpdate))
  view.dispatch({ selection: { anchor: 1 } })
  expect(onDocumentUpdate).not.toHaveBeenCalled()
  view.destroy()
})
```

Pending-only accept does not claim a doc change:

```ts
it("reports pending-only state changes without docChanged", async () => {
  const onDocumentUpdate = vi.fn()
  const view = createEditor(
    document.createElement("div"),
    editorOptions(onDocumentUpdate, "1. a\n3. b"),
  )
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  const accepted = acceptOrderedListNormalization(view.state, notice.id)
  if (accepted.kind === "accepted") view.dispatch(accepted.transaction)
  expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
    docChanged: false,
    pendingNormalization: null,
  }))
  view.destroy()
})
```

Reject remains outside undo history while user edits remain undoable:

```ts
it("keeps reject out of history and preserves user undo", async () => {
  const view = createEditor(document.createElement("div"), editorOptions(vi.fn(), "1. a\n3. b"))
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  const result = rejectOrderedListNormalization(view.state, notice.id)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nbody" } })
  expect(undo(view)).toBe(true)
  expect(view.state.doc.toString()).toBe("1. a\n3. b")
  expect(undo(view)).toBe(false)
  view.destroy()
})
```

Image integration getters are tab-bound:

```ts
it("keeps path and document identity bound to a background tab", () => {
  const options = harness.editorForTab(2).getOptions()
  harness.activateTab(1)
  expect(options.getDocPath()).toBe("/notes/background.md")
  expect(options.getDocumentId()).toBe(options.documentId)
})
```

## Banner interaction tests

Add click and ordering assertions:

```tsx
it("runs both named actions in document order", () => {
  const onSave = vi.fn()
  const onKeepOriginal = vi.fn()
  render(<NormalizationBanner markerCount={2} busy={false}
    onSave={onSave} onKeepOriginal={onKeepOriginal} />)
  const buttons = screen.getAllByRole("button")
  expect(buttons.map(button => button.textContent)).toEqual([
    "Save normalization",
    "Keep original numbers",
  ])
  fireEvent.click(buttons[0])
  fireEvent.click(buttons[1])
  expect(onSave).toHaveBeenCalledOnce()
  expect(onKeepOriginal).toHaveBeenCalledOnce()
})

While `busy`, both buttons use `aria-disabled` (not native `disabled`), stay focusable, and ignore clicks:

```tsx
it("disables both actions while busy without dropping their focus", () => {
  const onSave = vi.fn()
  const onKeepOriginal = vi.fn()
  render(<NormalizationBanner markerCount={1} busy
    onSave={onSave} onKeepOriginal={onKeepOriginal} />)
  const buttons = screen.getAllByRole("button")
  expect(buttons.map(button => button.getAttribute("aria-disabled"))).toEqual([
    "true",
    "true",
  ])
  for (const button of buttons) {
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
  }
  expect(onSave).not.toHaveBeenCalled()
  expect(onKeepOriginal).not.toHaveBeenCalled()
})
```

Add a StatusBar test in the same file or `StatusBar.test.tsx`: `untitled •` remains one text node while `Normalization review required` is separate.

## Reset and background-tab integration tests

Background update:

```ts
it("routes background pending to its bound tab", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openInNewTab("/notes/b.md", "1. a\n3. b")
  harness.activateTab(1)
  harness.editorForTab(2).emit({
    doc: "1. a\n2. b",
    docChanged: true,
    pendingNormalization: { id: normalizationId(1), markerCount: 1 },
  })
  expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
  harness.activateTab(2)
  expect(screen.getByRole("status").textContent).toContain("1")
})
```

Reset rollback:

```ts
it("binds reset options to the bumped document identity", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  const before = harness.editorForTab(1).getOptions().documentId
  await harness.requestOpen("/notes/new.md", "1. a\n3. b")
  expect(harness.editorForTab(1).getOptions().documentId).toBe(before + 1)
})

it("restores session identity and projection when reset throws", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  harness.failNextReset(new Error("reset failed"))
  await harness.requestOpen("/notes/new.md", "1. a\n3. b")
  expect(screen.getByText("untitled")).toBeTruthy()
  harness.editorForTab(1).emit({
    doc: "still editable",
    docChanged: true,
    pendingNormalization: null,
  })
  expect(screen.getByText("untitled •")).toBeTruthy()
})

it("removes a closed tab projection before reusing the workspace", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openInNewTab("/notes/b.md", "1. a\n3. b")
  harness.emitPending(2, normalizationId(1))
  harness.requestCloseTab(2)
  await harness.openInNewTab("/notes/c.md", "body")
  expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
})
```

Add code-shaped cases with the same harness:

- `pending-only update does not call writeRecovery`
- `open, external reload, and draft restore clear stale projection before reset`
- `closing a pending tab removes its projection`

## Autosave and concurrency tests

Timer cancellation:

```ts
it("cancels autosave when pending arrives", async () => {
  vi.useFakeTimers()
  const harness = makeAppHarness()
  harness.renderApp({ autosaveMs: 100 })
  await harness.openIntoActive("/notes/a.md", "saved")
  harness.editorForTab(1).emit({
    doc: "edited", docChanged: true, pendingNormalization: null,
  })
  harness.editorForTab(1).emit({
    doc: "edited", docChanged: false,
    pendingNormalization: { id: normalizationId(1), markerCount: 1 },
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(harness.services.writeFile).not.toHaveBeenCalled()
  vi.useRealTimers()
})
```

Pending blocks an autosave that starts after the notice:

```ts
it("does not autosave a pending normalization", async () => {
  vi.useFakeTimers()
  const harness = makeAppHarness()
  harness.renderApp({ autosaveMs: 100 })
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.editorForTab(1).emit({
    doc: "1. a\n2. b",
    docChanged: true,
    pendingNormalization: { id: normalizationId(1), markerCount: 1 },
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(harness.services.writeFile).not.toHaveBeenCalled()
  expect(harness.services.writeRecovery).toHaveBeenCalled()
  vi.useRealTimers()
})
```

Pure pending updates do not rewrite recovery:

```ts
it("does not write recovery for a pending-only update", () => {
  const harness = makeAppHarness()
  harness.renderApp()
  harness.editorForTab(1).emit({
    doc: "",
    docChanged: false,
    pendingNormalization: { id: normalizationId(1), markerCount: 1 },
  })
  expect(harness.services.writeRecovery).not.toHaveBeenCalled()
})
```

Wrong-view protection:

```ts
it("accepts two pending tabs independently", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  await harness.openInNewTab("/notes/b.md", "1. x\n4. y")
  harness.emitPending(1, normalizationId(1))
  harness.emitPending(2, normalizationId(2))
  await harness.saveNormalization(1)
  await harness.saveNormalization(2)
  expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
  expect(harness.editorForTab(2).view.dispatch).toHaveBeenCalledOnce()
})
```

Switching tabs does not redirect save completion:

```ts
it("updates only the captured tab after switching during save", async () => {
  const write = deferred<void>()
  const harness = makeAppHarness()
  vi.mocked(harness.services.writeFile).mockReturnValueOnce(write.promise)
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  await harness.openInNewTab("/notes/b.md", "body")
  harness.emitPending(1, normalizationId(1))
  const saving = harness.saveNormalization(1)
  harness.activateTab(2)
  write.resolve()
  await saving
  expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
  expect(harness.editorForTab(2).view.dispatch).not.toHaveBeenCalled()
})

it("keeps edits made after the saved snapshot dirty", async () => {
  const write = deferred<void>()
  const harness = makeAppHarness()
  vi.mocked(harness.services.writeFile).mockReturnValueOnce(write.promise)
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  const saving = harness.saveNormalization(1)
  harness.editorForTab(1).emit({
    doc: "1. a\n2. b\nlater",
    docChanged: true,
    pendingNormalization: { id: normalizationId(1), markerCount: 1 },
  })
  write.resolve()
  await saving
  expect(screen.getByText("/notes/a.md •")).toBeTruthy()
})

it("keeps pending idle when Save As is cancelled", async () => {
  const harness = makeAppHarness()
  vi.mocked(harness.services.pickSavePath).mockResolvedValueOnce(null)
  harness.renderApp()
  harness.emitPending(1, normalizationId(1))
  await harness.saveNormalization(1)
  expect(harness.services.writeFile).not.toHaveBeenCalled()
  const saveButton = screen.getByRole("button", { name: "Save normalization" })
  expect(saveButton.getAttribute("aria-disabled")).not.toBe("true")
})
```

Reject dispatches and focuses only the captured view:

```ts
it("rejects on the captured view and restores focus", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  vi.mocked(rejectOrderedListNormalization).mockReturnValue({
    kind: "reverted",
    transaction: { changes: { from: 5, to: 7, insert: "3." } },
    restoredMarkers: 1,
    skippedMarkers: 0,
  })
  fireEvent.click(screen.getByRole("button", { name: "Keep original numbers" }))
  expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
  expect(harness.editorForTab(1).view.focus).toHaveBeenCalledOnce()
})

it("announces skipped source-mode markers without an alert", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  vi.mocked(rejectOrderedListNormalization).mockReturnValue({
    kind: "reverted",
    transaction: {},
    restoredMarkers: 0,
    skippedMarkers: 1,
  })
  fireEvent.click(screen.getByRole("button", { name: "Keep original numbers" }))
  expect(screen.getByText(
    "Original numbers were restored where they were unchanged.",
  )).toBeTruthy()
  expect(harness.services.reportError).not.toHaveBeenCalled()
})
```

Save failure resyncs idle with the fresh notice:

```ts
it("keeps review pending after save failure", async () => {
  const harness = makeAppHarness()
  vi.mocked(harness.services.writeFile).mockRejectedValueOnce(new Error("disk full"))
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  await harness.saveNormalization(1)
  const saveButton = screen.getByRole("button", { name: "Save normalization" })
  expect(saveButton.getAttribute("aria-disabled")).not.toBe("true")
  expect(harness.services.reportError).toHaveBeenCalled()
})
```

Add exact cases:

- save failure leaves fresh notice idle and autosave paused
- Save As cancellation does the same without error reporting
- switching tabs after write starts updates only captured tab baseline
- editing after snapshot keeps dirty
- stale documentId and replaced view both prevent dispatch
- external “load disk” clears pending; “keep mine” preserves it
- existing save queue serialization, stale open response, failed save baseline, and Save As reuse tests remain green

```ts
it("clears pending when external disk content is loaded", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
  vi.mocked(harness.services.confirmExternalChange).mockReturnValueOnce(true)
  await harness.runExternalCheck()
  expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
  expect(screen.getByText("/notes/a.md")).toBeTruthy()
})

it("keeps pending when external disk content is rejected", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
  vi.mocked(harness.services.confirmExternalChange).mockReturnValueOnce(false)
  await harness.runExternalCheck()
  expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
})
```

## Coordinator pure tests

Use exact signatures:

```ts
export function canAutosaveTab(
  tabId: number,
  state: NormalizationByTab,
): boolean

export function isCurrentNormalizationTarget(
  capture: NormalizationOperationCapture,
  workspace: Workspace,
  views: ReadonlyMap<number, EditorView>,
  currentNotice: OrderedListNormalizationNotice | null,
): boolean
```

```ts
const targetView = {} as EditorView
const workspace = addTab(createWorkspace(), {
  ...createSession(2, "/notes/b.md", "b"),
  documentId: 8,
})
const views = new Map<number, EditorView>([[2, targetView]])

function makeCapture(
  overrides: Partial<NormalizationOperationCapture> = {},
): NormalizationOperationCapture {
  return {
    tabId: 2,
    documentId: 8,
    view: targetView,
    normalizationId: notice.id,
    ...overrides,
  }
}

it("blocks autosave only for the pending tab", () => {
  const state = projectNormalizationNotice({}, 2, notice)
  expect(canAutosaveTab(1, state)).toBe(true)
  expect(canAutosaveTab(2, state)).toBe(false)
})

it("requires tab, document, view, and notice identity to match", () => {
  const capture = makeCapture({ tabId: 2, documentId: 8, normalizationId: notice.id })
  expect(isCurrentNormalizationTarget(capture, workspace, views, notice)).toBe(true)
  expect(isCurrentNormalizationTarget({ ...capture, documentId: 9 }, workspace, views, notice)).toBe(false)
  expect(isCurrentNormalizationTarget(capture, workspace, new Map(), notice)).toBe(false)
  expect(isCurrentNormalizationTarget(capture, workspace, views, null)).toBe(false)
})
```

## Remaining matrix cases

Task 6 adds:

```ts
it("updates marker count without clearing a busy action", () => {
  const saving = setNormalizationAction(
    projectNormalizationNotice({}, 1, notice), 1, notice.id, "saving",
  )
  const next = projectNormalizationNotice(saving, 1, { ...notice, markerCount: 4 })
  expect(next[1]).toEqual({
    notice: { ...notice, markerCount: 4 },
    action: "saving",
  })
})

it("confirms before closing a pending-only dirty tab", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  harness.requestCloseTab(1)
  expect(harness.services.confirmClose).toHaveBeenCalledOnce()
})
```

## Projection null behavior

Task 3 adds:

```ts
it("removes a tab when projected or resynced notice is null", () => {
  const state = projectNormalizationNotice({}, 1, notice)
  expect(projectNormalizationNotice(state, 1, null)[1]).toBeUndefined()
  expect(resyncNormalizationIdle(state, 1, null)[1]).toBeUndefined()
})
```
