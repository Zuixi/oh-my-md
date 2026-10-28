# Editor Ownership Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn two theoretical multi-view/event-order risks into executable contracts before changing production architecture.

**Architecture:** Add integration tests using real `EditorView` instances and the real desktop extension order. Change registries or paste routing only when a test demonstrates incorrect behavior.

**Tech Stack:** TypeScript, CodeMirror 6, happy-dom, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- One mounted `EditorView` per tab remains the product model.
- Engine keeps Markdown semantics; desktop owns clipboard/image/context-menu orchestration.
- Do not add a generic event bus or paste framework in this plan.
- Tests must mount the same extension order as `createEditor`.

---

### Task 1: Guard identical block widgets across two views

**Files:**
- Modify: `packages/engine/test/view.test.ts`
- Potential follow-up only if test fails: `packages/engine/src/decorations/blockSelectionOverlay.ts`

**Interfaces:**
- Consumes: `editorExtensions()`.
- Produces: a two-view test proving widget range/selection isolation.

- [ ] **Step 1: Write the two-view regression**

Mount two `EditorView`s with the same document:

```ts
const doc = "before\n\n```js\nconst x = 1\n```\n\nafter"
const first = makeView(doc, 0)
const second = makeView(doc)
```

Wait for both `.omd-code .line` elements. Click the rendered line in `second.view`, then assert:

```ts
expect(second.view.dom.querySelector(".omd-code")).toBeNull()
expect(second.view.state.selection.main.head).toBe(doc.indexOf("const x"))
expect(first.view.dom.querySelector(".omd-code")).toBeTruthy()
expect(first.view.state.selection.main.head).toBe(0)
```

Then create a full-range selection in the first view and assert `.omd-block-covered` appears only in the first view.

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @omd/engine exec vitest run test/view.test.ts \
  -t "keeps identical widgets isolated across views"
```

- [ ] **Step 3: Apply the decision**

- If the test passes, make no production change and keep the test as the contract.
- If it fails, replace module-global maps with:

```ts
interface ViewRegistry {
  readonly wraps: Map<BlockWidget, HTMLElement>
  readonly ranges: WeakMap<HTMLElement, { from: number; to: number }>
}

const registries = new WeakMap<EditorView, ViewRegistry>()
const widgetViews = new WeakMap<BlockWidget, EditorView>()
```

Change `registerBlockWidget` to receive `view`, store `widgetViews.set(widget, view)`, and update all widget registration call sites. Keep `unregisterBlockWidget(widget)` view-free: `WidgetType.destroy(dom)` does not receive an `EditorView`, so unregister must recover the owner through `widgetViews`, remove the entry from that view's registry, and then delete the ownership entry. Do not cache a strong `EditorView` reference on the widget and do not use one process-global fallback scan.

- [ ] **Step 4: Run engine tests**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/test/view.test.ts \
  packages/engine/src/decorations/blockSelectionOverlay.ts \
  packages/engine/src/decorations/blockWidget.ts \
  packages/engine/src/decorations/widgets/code.ts \
  packages/engine/src/decorations/widgets/table.ts
git commit -m "test: guard block widget isolation across views"
```

Stage only production files that actually changed.

### Task 2: Guard paste-handler ownership in the assembled editor

**Files:**
- Modify: `apps/desktop/test/Editor.test.ts`
- Modify: `apps/desktop/test/imagePaste.test.ts`
- Potential follow-up only if tests fail: `apps/desktop/src/Editor.ts`, `apps/desktop/src/imagePaste.ts`, `packages/engine/src/paste/htmlPaste.ts`

**Interfaces:**
- Uses the real order:

```text
editorExtensions(htmlPaste) → typewriterExtension → imagePasteHandler
```

- [ ] **Step 1: Add full-editor ownership tests**

Add four cases using `createEditor`:

1. clipboard contains image + HTML + plain text → image handler owns it; rich Markdown is not inserted;
2. keyboard HTML paste in prose → engine converts to Markdown;
3. right-click paste on macOS with HTML + plain-text clipboard flavors → desktop inserts the plain-text flavor at the saved context-menu target;
4. read-only view with HTML clipboard → event is consumed and the document stays unchanged.

Use one helper:

```ts
function firePaste(
  view: EditorView,
  data: Record<string, string>,
  items: readonly DataTransferItem[] = [],
) {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => data[type] ?? "",
      items,
    },
  })
  view.contentDOM.dispatchEvent(event)
}
```

- [ ] **Step 2: Run the focused desktop tests**

```bash
pnpm --filter @omd/desktop exec vitest run \
  test/Editor.test.ts \
  test/imagePaste.test.ts
```

- [ ] **Step 3: Apply the smallest fix only if a contract fails**

Preferred correction order:

1. extension order or an early `return false`;
2. a host callback in `EngineOptions` when the engine must defer a clipboard flavor;
3. only after two independent ordering failures, export a pure engine helper:

```ts
export async function richPasteSpec(
  state: EditorState,
  clipboard: ClipboardLike,
  from: number,
  to: number,
): Promise<TransactionSpec | null>
```

and let desktop own the single DOM `paste` handler.

Do not jump directly to option 3; it moves event ownership and async selection validation at once.

- [ ] **Step 4: Run full frontend and engine validation**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test/Editor.test.ts apps/desktop/test/imagePaste.test.ts
git commit -m "test: define assembled editor paste ownership"
```

Include production files only if a failing contract required them.

## Why This Plan, Not the Alternatives

- **Why tests before per-view registries:** module-global state is suspicious but not automatically wrong; current identity and `view.dom.contains` checks may already provide isolation.
- **Why full-editor paste tests:** isolated engine and image-paste tests cannot verify extension ordering.
- **Why not centralize paste immediately:** the current split reflects a valid ownership boundary—engine knows Markdown, desktop knows images and WebKit context-menu behavior. Centralization is justified only when ordering cannot be expressed safely.
- **Why no generic event bus:** CodeMirror facets and extension ordering already provide the required composition mechanism.
