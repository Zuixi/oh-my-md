# 有序列表自动规范化安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留 Live Preview 自动规范化编号，同时让 preview-entry 自动改源可见、可拒绝、暂停自动保存且多标签安全。

**Architecture:** Engine 在 Live Preview compartment 外维护 pending/suppression StateField，暴露 notice 与纯 TransactionSpec 命令。Desktop callback 绑定 tabId/documentId，只保存按标签 UI 投影；显式保存和拒绝操作捕获并复核目标 EditorView，timer autosave 在 pending 时双重阻断。

**Tech Stack:** TypeScript 5.7, CodeMirror 6, React 19, Vitest 3, Testing Library, happy-dom, CSS。

**Spec:** `docs/superpowers/specs/2026-08-13-01-source-fidelity-design.md`

## Global Constraints

- Preview-entry 规范化创建 pending；用户编辑引发的 follow-up 规范化走普通 autosave。
- Pending 标记 dirty、继续 recovery、禁止 timer autosave。
- Pending/suppression 跨 Source/Live 保留；新 EditorState 重置二者。
- Reject 只恢复仍等于 normalized 的 marker，不覆盖后续编辑。
- Rust 不变；Engine 不导入 React/Tauri；Desktop 不解析 Markdown。
- 状态更新不可 mutation；函数 <50 行；文件 <800 行；嵌套 <4 层。
- 不启用 `indentOnInput`、`closeBrackets` 或通用 `autocompletion`。
- Commit 命令只是建议边界；没有用户授权不得执行。

---

## File Map

```text
packages/engine/src/lists/ordered.ts            pending/suppression、可逆 marker、命令
packages/engine/src/index.ts                    顶层挂 StateField、导出 API
packages/engine/src/modes/livePreview.ts        compartment 只拥有 preview/plugin
packages/engine/test/ordered-renumber.test.ts   状态、合并、revert、模式
packages/engine/test/view.test.ts               真实 EditorView 守门
apps/desktop/src/Editor.ts                      tab/document-bound update
apps/desktop/src/normalizationState.ts          按 tab UI 投影
apps/desktop/src/NormalizationBanner.tsx        非模态确认条
apps/desktop/src/session.ts                     advanceDocumentIdentity
apps/desktop/src/workspace.ts                   replaceTabSession
apps/desktop/src/App.tsx                        reset/save/reject 编排
apps/desktop/src/StatusBar.tsx                   review 状态
apps/desktop/src/styles.css                     banner/focus/theme
apps/desktop/test/*                              对应单元与集成测试
docs/{manual-qa.md,memory/known-gotchas.md}      QA 与永久不变量
```

---

### Task 1: Engine pending StateField 与命令 API

**Files:**
- Modify: `packages/engine/src/lists/ordered.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/ordered-renumber.test.ts`

**Interfaces:**
- Produces: `NormalizationId`, `OrderedListNormalizationNotice`
- Produces: `getPendingOrderedListNormalization`, `acceptOrderedListNormalization`, `rejectOrderedListNormalization`
- Consumed by: Tasks 2, 4, 6, 7

- [ ] **Step 1: Write failing pending/stale tests**

```ts
it("creates one pending notice for preview-entry normalization", async () => {
  const { view } = makeView("1. a\n3. b\n7. c")
  await tick()
  expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(2)
  view.destroy()
})

it("rejects stale command ids without changing the document", async () => {
  const { view } = makeView("1. a\n3. b")
  await tick()
  const notice = getPendingOrderedListNormalization(view.state)!
  const stale = (Number(notice.id) + 1) as typeof notice.id
  expect(acceptOrderedListNormalization(view.state, stale).kind).toBe("stale")
  expect(rejectOrderedListNormalization(view.state, stale).kind).toBe("stale")
  expect(view.state.doc.toString()).toBe("1. a\n2. b")
  view.destroy()
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @omd/engine test -- ordered-renumber.test.ts`  
Expected: FAIL because API exports do not exist.

- [ ] **Step 3: Define public types and private state**

```ts
declare const normalizationIdBrand: unique symbol
export type NormalizationId = number & {
  readonly [normalizationIdBrand]: "NormalizationId"
}
export interface OrderedListNormalizationNotice {
  readonly id: NormalizationId
  readonly markerCount: number
}
export type OrderedListNormalizationAcceptResult =
  | { readonly kind: "accepted"; readonly transaction: TransactionSpec }
  | { readonly kind: "stale" }
export type OrderedListNormalizationRejectResult =
  | {
      readonly kind: "reverted"
      readonly transaction: TransactionSpec
      readonly restoredMarkers: number
      readonly skippedMarkers: number
    }
  | { readonly kind: "stale" }
```

Private state uses immutable records:

```ts
interface ReversibleOrderedMarker {
  readonly from: number
  readonly to: number
  readonly original: string
  readonly normalized: string
}
interface OrderedNormalizationState {
  readonly nextId: number
  readonly pending: {
    readonly id: NormalizationId
    readonly markers: readonly ReversibleOrderedMarker[]
  } | null
  readonly suppressed: boolean
}
```

- [ ] **Step 4: Implement StateField and pure command builders**

`orderedNormalizationState` is exported for extension assembly, but annotation/effects remain private. Split field update, range mapping, accept, and reject into functions under 50 lines.

```ts
export function getPendingOrderedListNormalization(
  state: EditorState,
): OrderedListNormalizationNotice | null {
  const pending = state.field(orderedNormalizationState, false)?.pending
  return pending ? { id: pending.id, markerCount: pending.markers.length } : null
}
```

Accept returns an effect-only TransactionSpec. Reject builds one TransactionSpec containing safe marker changes, reject effect, and `Transaction.addToHistory.of(false)`. Stale id returns `{ kind: "stale" }`.

- [ ] **Step 5: Mount outside the compartment and export API**

In `index.ts`, place `orderedNormalizationState` directly in `editorExtensions()` before `livePreviewCompartment.of(...)`. Re-export the three functions and public types; do not add the StateField to `livePreviewExt()`.

- [ ] **Step 6: Verify green**

Run: `pnpm --filter @omd/engine test -- ordered-renumber.test.ts`  
Expected: existing rewrite tests and new pending/stale tests PASS.

- [ ] **Step 7: Suggested commit**

```sh
git add packages/engine/src/lists/ordered.ts packages/engine/src/index.ts packages/engine/test/ordered-renumber.test.ts
git commit -m "feat(engine): track pending ordered list normalization"
```

---

### Task 2: Engine multi-batch merge、revert 与 suppression

**Files:**
- Modify: `packages/engine/src/lists/ordered.ts`
- Modify: `packages/engine/src/modes/livePreview.ts`
- Modify: `packages/engine/test/ordered-renumber.test.ts`
- Modify: `packages/engine/test/view.test.ts`

**Interfaces:**
- Consumes: Task 1 StateField/API
- Produces: stable-id merge, preview-entry classification, session suppression

- [ ] **Step 1: Write failing safety tests**

```ts
it("rejects normalization without losing later body edits", async () => {
  const { view } = makeView("1. a\n3. b\n\nbody")
  await tick()
  view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } })
  const notice = getPendingOrderedListNormalization(view.state)!
  const result = rejectOrderedListNormalization(view.state, notice.id)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  expect(view.state.doc.toString()).toBe("1. a\n3. b\n\nbody edited")
  view.destroy()
})

it("skips a marker edited after automatic normalization", async () => {
  const { view } = makeView("1. a\n3. b")
  await tick()
  const line = view.state.doc.line(2)
  view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "9." } })
  const notice = getPendingOrderedListNormalization(view.state)!
  const result = rejectOrderedListNormalization(view.state, notice.id)
  expect(result.kind === "reverted" && result.skippedMarkers).toBe(1)
  if (result.kind === "reverted") view.dispatch(result.transaction)
  expect(view.state.doc.line(2).text).toBe("9. b")
  view.destroy()
})
```

- [ ] **Step 2: Add mode and repeated-marker tests**

Test names and exact assertions:

- `keeps pending across source/live toggles`: id and markerCount survive `applyToggle`.
- `keeps suppression across source/live toggles`: reject, toggle twice, source remains skipped.
- `merges repeated writes to one marker`: first original retained, latest normalized matched, count remains one, reject returns first source.
- `maps variable-length markers in new coordinates`: `10.` replacement does not touch adjacent text.
- `keeps user undo history`: reject is not undoable; later body edit is.

- [ ] **Step 3: Verify red**

Run: `pnpm --filter @omd/engine test -- ordered-renumber.test.ts view.test.ts`  
Expected: FAIL on classification, merge, mapping, and suppression.

- [ ] **Step 4: Annotate and classify batches**

```ts
interface OrderedNormalizationBatch {
  readonly trigger: "preview-entry" | "user-followup"
  readonly changes: readonly OrderedMarkChange[]
}
const orderedRenumberAnn = Annotation.define<OrderedNormalizationBatch>()
```

ViewPlugin starts with `hasUserDocChange = false`. A non-normalization doc transaction flips it before scheduling apply. Normalization transactions do not. Suppressed state returns before Lezer traversal; composing still returns.

- [ ] **Step 5: Merge marker records correctly**

Field algorithm:

1. Map old records through each transaction.
2. For a normalization batch, use `tr.changes.iterChanges` `fromB/toB`.
3. First batch allocates id; later preview batches reuse it.
4. Same mapped marker keeps first `original`, replaces latest `normalized`, does not increase count.
5. User-followup batches change the document but do not create/extend pending.

Keep a module-internal exported helper for direct tests:

```ts
export function mergeReversibleOrderedMarkers(
  existing: readonly ReversibleOrderedMarker[],
  incoming: readonly ReversibleOrderedMarker[],
): readonly ReversibleOrderedMarker[]
```

Do not re-export it from `index.ts`.

- [ ] **Step 6: Verify all Engine behavior**

Run: `pnpm --filter @omd/engine test`  
Expected: TypeScript and Vitest PASS; real EditorView exception sink remains empty.

- [ ] **Step 7: Suggested commit**

```sh
git add packages/engine/src/lists/ordered.ts packages/engine/src/modes/livePreview.ts packages/engine/test/ordered-renumber.test.ts packages/engine/test/view.test.ts
git commit -m "feat(engine): make list normalization reversible"
```

---

### Task 3: Desktop pure tab state and identity

**Files:**
- Create: `apps/desktop/src/normalizationState.ts`
- Create: `apps/desktop/test/normalizationState.test.ts`
- Modify: `apps/desktop/src/session.ts`
- Modify: `apps/desktop/test/session.test.ts`
- Modify: `apps/desktop/src/workspace.ts`
- Modify: `apps/desktop/test/workspace.test.ts`

**Interfaces:**
- Produces: `NormalizationByTab` and four transition functions
- Produces: `advanceDocumentIdentity`, `replaceTabSession`
- Consumed by: Tasks 6–7

- [ ] **Step 1: Write failing projection tests**

```ts
const id = 1 as NormalizationId
const notice = { id, markerCount: 2 }

it("projects tabs independently and rejects stale actions", () => {
  const first = projectNormalizationNotice({}, 1, notice)
  const second = projectNormalizationNotice(first, 2, { ...notice, markerCount: 3 })
  expect(first[2]).toBeUndefined()
  expect(second[1]?.notice.markerCount).toBe(2)
  expect(setNormalizationAction(second, 1, 2 as NormalizationId, "saving")).toBe(second)
})

it("resyncs fresh notice and idle atomically", () => {
  const saving = setNormalizationAction(
    projectNormalizationNotice({}, 1, notice), 1, id, "saving",
  )
  const next = resyncNormalizationIdle(saving, 1, { id, markerCount: 4 })
  expect(next[1]).toEqual({ notice: { id, markerCount: 4 }, action: "idle" })
  expect(clearTabNormalization(next, 1)[1]).toBeUndefined()
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @omd/desktop test -- normalizationState.test.ts`  
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement immutable transitions**

Implement spec signatures exactly. App may not spread/mutate the projection. `setNormalizationAction` only transitions matching idle state. `resyncNormalizationIdle(..., null)` removes the tab by object rest, not `delete`.

- [ ] **Step 4: Add and implement identity helpers**

Tests:

```ts
it("advances identity without changing path or baseline", () => {
  const session = createSession(4, "/a.md", "saved")
  expect(advanceDocumentIdentity(session)).toEqual({
    ...session, documentId: session.documentId + 1,
  })
})

it("replaces a background session without changing activeId", () => {
  const workspace = focusTab(addTab(createWorkspace(), createSession(2)), 1)
  const next = replaceTabSession(workspace, markSaved(workspace.tabs[1], "/b.md", "b"))
  expect(next.activeId).toBe(1)
  expect(next.tabs[1].savedContents).toBe("b")
})
```

Implementation:

```ts
export function advanceDocumentIdentity(session: EditorSession): EditorSession {
  return { ...session, documentId: session.documentId + 1 }
}
export function replaceTabSession(workspace: Workspace, session: EditorSession): Workspace {
  if (!workspace.tabs.some(tab => tab.id === session.id)) return workspace
  return { ...workspace, tabs: workspace.tabs.map(tab => tab.id === session.id ? session : tab) }
}
```

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @omd/desktop test -- normalizationState.test.ts session.test.ts workspace.test.ts`  
Expected: PASS.

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src/normalizationState.ts apps/desktop/src/session.ts apps/desktop/src/workspace.ts apps/desktop/test/normalizationState.test.ts apps/desktop/test/session.test.ts apps/desktop/test/workspace.test.ts
git commit -m "feat(desktop): add tab-scoped normalization state"
```

---

### Task 4: Bind Editor updates to document identity

**Files:**
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/test/Editor.test.ts`
- Modify: `apps/desktop/test/App.test.tsx` (mock signature)

**Interfaces:**
- Produces: `EditorDocumentUpdate`
- Changes: `CreateEditorOptions` gains tabId/documentId/onDocumentUpdate

- [ ] **Step 1: Write failing Editor tests**

```ts
it("reports bound identity and document changes", () => {
  const onDocumentUpdate = vi.fn()
  const view = createEditor(document.createElement("div"), {
    doc: "alpha", tabId: 7, documentId: 11,
    getDocPath: () => null, getDocumentId: () => 11,
    onDocumentUpdate, onError: vi.fn(),
  })
  view.dispatch({ changes: { from: 5, insert: "!" } })
  expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
    tabId: 7, documentId: 11, doc: "alpha!", docChanged: true,
  }))
  view.destroy()
})
```

Also assert selection-only transactions do not callback, and accepting a pending notice emits `docChanged: false` with `pendingNormalization: null`.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @omd/desktop test -- Editor.test.ts`  
Expected: FAIL on old callback signature.

- [ ] **Step 3: Implement the contract**

```ts
export interface EditorDocumentUpdate {
  readonly tabId: number
  readonly documentId: number
  readonly doc: string
  readonly docChanged: boolean
  readonly pendingNormalization: OrderedListNormalizationNotice | null
}
```

Listener compares start/end notice id and markerCount. It calls `onDocumentUpdate` only for doc or pending change, using bound options identity rather than active refs.

- [ ] **Step 4: Update App harness**

Replace every `onDocChanged(value)` mock call with a complete `onDocumentUpdate` object. Mock the three Engine normalization functions because the fake view has no StateField.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @omd/desktop test -- Editor.test.ts App.test.tsx`  
Expected: Editor tests PASS; App integration may remain red until Task 6.

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src/Editor.ts apps/desktop/test/Editor.test.ts apps/desktop/test/App.test.tsx
git commit -m "refactor(desktop): bind editor updates to document identity"
```

---

### Task 5: Accessible banner and StatusBar

**Files:**
- Create: `apps/desktop/src/NormalizationBanner.tsx`
- Create: `apps/desktop/test/NormalizationBanner.test.tsx`
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Produces: `NormalizationBannerProps`
- Changes: StatusBar gains `normalizationReviewRequired`

- [ ] **Step 1: Write failing component tests**

```tsx
it("announces count and exposes both actions", () => {
  render(<NormalizationBanner markerCount={2} busy={false}
    onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
  expect(screen.getByRole("status").textContent).toContain("2")
  expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Keep original numbers" })).toBeTruthy()
})

it("disables both actions while busy", () => {
  render(<NormalizationBanner markerCount={1} busy
    onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
  expect(screen.getAllByRole("button").every(button => button.hasAttribute("disabled"))).toBe(true)
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @omd/desktop test -- NormalizationBanner.test.tsx`  
Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement component and status**

Banner uses `role="status"`, text count, two named native buttons, and `busy` disabled state. StatusBar keeps path + dirty in its existing text node and adds a separate conditional `Normalization review required` span.

- [ ] **Step 4: Add CSS**

Use existing variables only. Add clear `:focus-visible`, ≥24×24 targets, wrapping narrow layout, AA text contrast, no gradient/shadow/opacity-only status.

- [ ] **Step 5: Verify**

Run:

```sh
pnpm --filter @omd/desktop test -- NormalizationBanner.test.tsx
pnpm --filter @omd/desktop build
```

Expected: PASS.

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src/NormalizationBanner.tsx apps/desktop/src/StatusBar.tsx apps/desktop/src/styles.css apps/desktop/test/NormalizationBanner.test.tsx
git commit -m "feat(desktop): add normalization review banner"
```

---

### Task 6: Wire per-tab updates, reset ordering, and UI

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5
- Produces: tab-safe update/reset lifecycle

- [ ] **Step 1: Write failing integration tests**

Add named tests:

- `routes a background editor update to its bound tab without changing activeId`
- `commits bumped documentId before resetting an active view`
- `does not write recovery for a pending-only update`
- `clears old projection before open, external reload, and draft restore`
- `removes projection when its tab closes`

Use rendered banner/tab assertions and captured reset options, not private React state.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @omd/desktop test -- App.test.tsx`  
Expected: FAIL because App still routes through active session.

- [ ] **Step 3: Add projection state and bound options**

```ts
const [normalizationByTab, setNormalizationByTab] =
  useState<NormalizationByTab>({})
const normalizationRef = useRef(normalizationByTab)
```

Create one immutable commit helper that updates ref and state. `ensureViews()` calls `editorOptions(doc, tab.id, tab.documentId)`.

- [ ] **Step 4: Implement `handleDocumentUpdate`**

1. Find bound tab; return on missing/stale documentId.
2. For `docChanged`, update that tab’s docs map; update active doc state only when active; handle recovery rejection.
3. Project notice for `update.tabId`.
4. Never call `replaceActive` for background callbacks.

- [ ] **Step 5: Implement one reset helper**

For open, external load, and recovery:

1. Compute bumped next session (`openSession` or `advanceDocumentIdentity`).
2. Commit via `replaceTabSession`.
3. Clear old projection.
4. Reset with next documentId.
5. Sync contents.

This order is load-bearing; do not reset before bumping identity.

- [ ] **Step 6: Render UI and close safely**

Render only active tab’s banner near editor stack. Pass review state to StatusBar. Clear projection before tab destruction; pending-only dirty still uses close confirmation.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @omd/desktop test -- App.test.tsx workspace.test.ts session.test.ts`  
Expected: PASS.

- [ ] **Step 8: Suggested commit**

```sh
git add apps/desktop/src/App.tsx apps/desktop/test/App.test.tsx
git commit -m "feat(desktop): surface pending list normalization"
```

---

### Task 7: Autosave pause、explicit accept、reject 与并发

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- Produces: `SaveTrigger`, `NormalizationOperationCapture`
- Provides to spec 02: tab/document-scoped save completion

- [ ] **Step 1: Write failing timer tests**

Test names and assertions:

- `does not autosave while normalization review is pending`: fake timer passes autosaveMs; `writeFile` remains zero.
- `cancels an armed timer when pending arrives`: ordinary edit arms timer; pending-only update cancels it.
- `continues recovery for real changes while pending`: `writeRecovery` receives normalized doc.

- [ ] **Step 2: Write failing explicit-save tests**

Cover:

- Banner and Cmd+S use `saveFile(tabId, "explicit")`.
- Success dispatches accept only to captured view/id.
- Failure/cancel resyncs fresh notice + idle.
- Switching tabs after write begins does not cancel write or update wrong baseline.
- Edits during save remain dirty after captured baseline updates.

- [ ] **Step 3: Write failing reject tests**

Assert idle → reverting, captured-view dispatch, stale identity resync, skipped-marker informational copy, and focus restoration.

- [ ] **Step 4: Verify red**

Run: `pnpm --filter @omd/desktop test -- App.test.tsx`  
Expected: FAIL until trigger-aware save exists.

- [ ] **Step 5: Implement trigger-aware save**

```ts
type SaveTrigger = "autosave" | "explicit"
interface NormalizationOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly normalizationId: NormalizationId
}
```

Autosave returns before queueing when the tab has pending. Explicit save captures tab/document/view/id/snapshot and sets saving only if the pure transition returns a new state. Effect dependencies include active tab, doc/path/dirty, timeout, and active pending id.

- [ ] **Step 6: Validate completion and dispatch**

Before accept/reject dispatch, verify tab exists, documentId matches, `viewsRef.get(tabId) === view`, and Engine pending id matches. Update baseline with `replaceTabSession`, never active refs. Stale paths resync from target view.

Reject implementation:

```ts
const result = rejectOrderedListNormalization(capture.view.state, capture.normalizationId)
if (result.kind === "stale") return resyncFromView(capture.tabId, capture.view)
capture.view.dispatch(result.transaction)
capture.view.focus()
```

- [ ] **Step 7: Cover external changes**

“Load disk” uses reset helper and clears old pending; “Keep mine” preserves pending and autosave pause. Add both tests.

- [ ] **Step 8: Verify Desktop**

Run:

```sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: all tests and build PASS.

- [ ] **Step 9: Suggested commit**

```sh
git add apps/desktop/src/App.tsx apps/desktop/test/App.test.tsx
git commit -m "feat(desktop): confirm automatic list normalization"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `packages/engine/AGENTS.md`
- Modify: `apps/desktop/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

**Interfaces:**
- Consumes: Tasks 1–7 final behavior
- Produces: permanent constraints and QA gates

- [ ] **Step 1: Update domain guidance**

Engine guide records top-level pending StateField, first-original/latest-normalized merge, public commands, and session suppression. Desktop guide records tab-bound callbacks, reset-before-bump prohibition, pending autosave pause, and explicit-save acceptance.

- [ ] **Step 2: Update known gotcha and parent design**

Record that “Keep original” preserves source but preview labels remain consecutive; suppression survives Source/Live. Add design flow:

```text
preview-entry normalization → dirty + recovery → pause autosave
  ├─ Save normalization → explicit save → clear pending
  └─ Keep original → targeted revert → session suppression
```

- [ ] **Step 3: Add manual QA**

Include all spec cases: disk unchanged after timeout, later edits survive reject, edited marker skipped, Source/Live persistence, reopen reset, multi-tab identity, external branches, close confirmation, keyboard, VoiceOver, and IME.

- [ ] **Step 4: Scan the plan and diff**

Run:

```sh
rg -n "T[B]D|T[O]DO|implement later|适当处理|待补充" docs/superpowers/plans/2026-08-13-01-source-fidelity.md
git diff --check
```

Expected: no matches; diff check exits 0.

- [ ] **Step 5: Run full automated verification**

```sh
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

Expected: all commands exit 0. Cargo is not required because Rust is unchanged.

- [ ] **Step 6: Run targeted GUI QA**

Run `pnpm dev`, execute new manual cases, and record actual results. Never mark VoiceOver, IME, or GUI checks passed without running them.

- [ ] **Step 7: Review final diff**

Confirm functions/files remain within limits, no state mutation, no unhandled save/recovery rejection, no wrong-view dispatch, and all controls have text names.

- [ ] **Step 8: Suggested commit**

```sh
git add packages/engine/AGENTS.md apps/desktop/AGENTS.md docs/memory/known-gotchas.md docs/manual-qa.md docs/superpowers/specs/2026-08-10-oh-my-md-design.md
git commit -m "docs: document safe list normalization workflow"
```

---

## Execution Handoff

Execute Tasks 1–8 in order. Recommended mode: `superpowers:subagent-driven-development`, one fresh subagent per Task, followed by spec-compliance and code-quality review.
