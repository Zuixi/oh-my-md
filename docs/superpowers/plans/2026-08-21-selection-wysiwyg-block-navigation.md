# Selection WYSIWYG and Block Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live-preview selection and vertical cursor motion match Typora semantics: selections stay visual (rendered blocks and inline marks never reveal source), pointer selection never cascades onto the next line, and ↑/↓ enters rendered blocks line by line instead of skipping them.

**Architecture:** Four independent fixes inside `@omd/engine` (plus one CSS addition in desktop). Design principle threaded through all of them: **selection is visual, the caret is editing**. (A) narrow the `atomicRanges` set so `skipAtomsForSelection` cannot push a selection end across a newline; (B) `blockSelected` returns false when a selection *fully covers* a block widget, keeping it rendered with a covered overlay; (C) inline-mark reveal conditions only fire for collapsed carets; (D) a `Prec.high` ArrowUp/ArrowDown keymap dispatches a selection inside an adjacent block widget, unmounting it into source form (same path as mouse click).

**Tech Stack:** CodeMirror 6 (`@codemirror/view` 6.43.8, `@codemirror/state` 6.7.1), Lezer Markdown, TypeScript strict, Vitest with happy-dom.

**Spec:** This plan implements the root-cause analysis from the 2026-08-21 editor UX investigation (three user-reported issues: block-wise ↑/↓ motion, source exposure during selection across tables, click selection highlighting the next line).

## Global Constraints

- Engine is framework-independent: no React/Tauri imports in `packages/engine/src/**` (engine AGENTS.md Domain Boundaries).
- Block widgets must keep coming from the `livePreviewField` StateField, never a ViewPlugin ("Block decorations may not be specified via plugins").
- `widget:block:*` tags stay out of the atomic set (known-gotchas atomicRanges Rule 2 — unchanged by this plan).
- Engine keymaps that must beat desktop `defaultKeymap` need `Prec.high` (desktop registers `defaultKeymap` before `editorExtensions()`).
- Happy-dom has no layout: `coordsAtPos`/`elementAtHeight` paths cannot be unit-tested; pure logic must be extracted and tested headless.
- Commit subjects: `<type>: <why>` with types `fix`/`docs`/`test`/`chore`; no `Co-authored-by` trailers (stripped by commit-msg hook).
- Verify per commit: `pnpm test` (engine tsc + vitest). Cross-domain commits also need `pnpm --filter @omd/desktop test`.
- Working directory for all commands: the worktree root (`.worktrees/selection-wysiwyg` from repo root).
- Do not modify `.vscode/settings.json` or `apps/desktop/src-tauri/tauri.conf.json` — they carry unrelated uncommitted changes in the main checkout (they are clean in this worktree; keep them that way).

## Root Causes (verified against source)

1. **Selection cascades to next line**: CM's `applyDOMChange`→`skipAtomsForSelection` (view 6.43.8 dist/index.js:4311-4314) runs on every pointer-origin selection sync, and `skipAtomicRanges` loops — an endpoint pushed to `line.to` can land inside the next line's *line-start atom* (`## `, `> `, `- `, Setext block replace) and be pushed again, crossing the newline. The engine feeds all `replace:*`/`widget:*` (except `widget:block:*`) into the atomic set via `isAtomicTag` (`build.ts:53-56`), including line-start marks and the newline-spanning Setext `replace:HeaderMark` (`inline.ts:98-103`).
2. **Blocks expose source when selected**: `blockSelected` (`blockWidget.ts:31-34`) treats *any* overlap (including full containment by Cmd+A or a drag across) as edit intent, so `blocks.ts` stops emitting the widget.
3. **Inline marks expose source when selected**: `nearCursor` (`types.ts:11-16`) reveals the whole cursor-head line for *any* selection; `cursorInside` (`types.ts:20-28`) returns true for any non-empty selection overlapping a mark. During a drag this also flips folds on/off, relayouting lines mid-drag, which feeds root cause 1.
4. **↑/↓ skip whole blocks**: `posAtCoords` with `scanY` (view 6.43.8 dist/index.js:3808-3814) deliberately skips non-text blocks for vertical motion; CM's author confirms the fix is custom ArrowUp/ArrowDown commands (discuss.codemirror.net/t/9491). The engine has no arrow-key handling today.

---

### Task 1: Narrow atomicRanges to mid-line atoms

**Files:**
- Modify: `packages/engine/src/decorations/build.ts:47-77` (isAtomicTag + decorationSets) and `:376` (update filter)
- Test: `packages/engine/test/view.test.ts` (extend atomic test)

**Interfaces:**
- Produces: `isAtomicSpec(spec: DecoSpec, state: EditorState): boolean` (module-private). `decorationSets(specs, state)` gains a `state` parameter — internal only, `buildLiveDecorations` (L81-90) and `seedLiveDecorations` (L95-112) are its only callers and both have `state` in scope.

- [ ] **Step 1: Write the failing test**

In `packages/engine/test/view.test.ts`, next to the existing `"atomic ranges exclude mark decorations"` test (~L151), add:

```ts
it("keeps line-start and cross-line marks out of atomic ranges", () => {
  const doc = "# Title\n\n> quoted\n\n- item\n\nSetext\n===\n\ntext with **bold** here\n"
  const state = makeState(doc, [livePreviewField])
  drainSync(state)
  const atomic: [number, number][] = []
  state.field(livePreviewField).atomic.between(0, doc.length, (from, to) => {
    atomic.push([from, to])
  })
  for (const [from, to] of atomic) {
    const line = state.doc.lineAt(from)
    // line-start atoms (heading marks, quote marks, list indent/mark) and any
    // atom crossing a line end are excluded — skipAtomsForSelection must never
    // be able to cascade an endpoint across a newline
    expect(from === line.from).toBe(false)
    expect(to <= line.to).toBe(true)
  }
  // mid-line atoms (emphasis marks around "bold") remain atomic
  expect(atomic.some(([from, to]) => to - from === 2 && doc.slice(from, to) === "**")).toBe(true)
})
```

Follow the import/test style of the existing atomic test in that file (it already imports `livePreviewField` and constructs states; use the same helper — if the file's states come from `makeState(doc, [livePreviewField])` + `drainPendingLiveBuild` on a mounted view, mirror that exactly; check the file top for the established pattern). The `drainSync(state)` placeholder above means "whatever that file already does to get a fully-built field" — copy it verbatim from the neighboring test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- atomic` (from worktree root; vitest filters by filename pattern, the file is `test/view.test.ts`)
Expected: FAIL — the line-start `replace:HeaderMark` (positions 0-2 `# `) is present in `atomic`, so `expect(from === line.from).toBe(false)` fails at the heading.

- [ ] **Step 3: Implement isAtomicSpec**

In `build.ts`, replace `isAtomicTag` (L53-56) and thread `state` through `decorationSets`:

```ts
// 原子区间只收“行中”的内联 replace 类装饰（折叠的语法标记 + 内联 widget，如 checkbox）。
// 两条排除规则（在既有 replace:*/widget:* 前缀规则之上）：
//   Rule 1（不变）— mark:/line: 不进原子区间：光标移动/删除会被锁死在样式文本外。
//   Rule 2（不变）— widget:block:* 不进原子区间：↑/↓ 跳整块、右键粘贴连选下一行。
//   Rule 3（新增）— 行首原子（from === line.from）与跨行原子（to > line.to）不进
//     原子区间：skipAtomsForSelection 会把指针选区端点循环外推，行首/跨行原子让
//     外推跨过换行符级联到下一行（“点击选中连带高亮下一行”）。行首标记退出后
//     不会产生不可见光标：nearCursor 的行级显源码会把整行展开（自愈路径）。
function isAtomicSpec(spec: DecoSpec, state: EditorState): boolean {
  if (!isAtomicTag(spec.tag)) return false
  const line = state.doc.lineAt(spec.from)
  return spec.from > line.from && spec.to <= line.to
}

function isAtomicTag(tag: string) {
  return (tag.startsWith("replace:") || tag.startsWith("widget:")) &&
    !tag.startsWith("widget:block:")
}
```

Then:
- `decorationSets(specs: DecoSpec[], state: EditorState)` — replace `s => isAtomicTag(s.tag)` with `s => isAtomicSpec(s, state)`; update its two callers (`buildLiveDecorations`, `seedLiveDecorations`) to pass `state`.
- In `updateLiveDecorations` (~L376), replace `.filter(spec => isAtomicTag(spec.tag))` with `.filter(spec => isAtomicSpec(spec, tr.state))`.

Also update the comment block at L47-52 to note Rule 3 (the code comment above already does; trim duplication so the comment lives once).

- [ ] **Step 4: Run engine tests to verify pass**

Run: `pnpm test`
Expected: PASS (374 existing + 1 new). If `"atomic ranges exclude mark decorations"` or the right-click-paste regressions fail, re-check that mid-line atoms (`**`, URL, inline math, checkbox `[ ]`) still enter the set.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/decorations/build.ts packages/engine/test/view.test.ts
git commit -m "fix: exclude line-start and cross-line atoms so pointer selection cannot cascade across lines"
```

---

### Task 2: Keep block widgets rendered when fully covered

**Files:**
- Modify: `packages/engine/src/decorations/blockWidget.ts:31-34` (blockSelected), `:64-106` (toDOM/destroy registration)
- Create: `packages/engine/src/decorations/blockSelectionOverlay.ts`
- Modify: `packages/engine/src/modes/livePreview.ts:7-12` (livePreviewExt array)
- Modify: `apps/desktop/src/styles.css` (covered overlay style)
- Test: `packages/engine/test/blockwidgets.test.ts`, `packages/engine/test/view.test.ts`

**Interfaces:**
- Produces: `blockSelected(state, from, to): boolean` — new semantics (caret-in-block or partial overlap → true; selection fully covers `[from, to]` → false). Same signature, all five call sites in `blocks.ts` keep working unchanged.
- Produces: `registerBlockWidget(widget, dom)` / `unregisterBlockWidget(widget)` in `blockSelectionOverlay.ts`, called from `BlockWidget.toDOM`/`destroy`; overlay class `omd-block-covered` toggled on the wrap element.

- [ ] **Step 1: Write the failing tests**

In `blockwidgets.test.ts`, extend the existing `blockSelected` test (~L45-59; it dynamically imports the function) with containment cases, and add a view-level test:

```ts
// inside the existing "blockSelected strict-overlap logic" describe/it — extend assertions:
// doc: "before\n\n```\ncode\n```\n\nafter"  (block spans 8..18, boundaries inclusive)
// selection 0..doc.length (Cmd+A)           → false  (full cover keeps widget)
// selection 0..20                            → false  (full cover)
// selection 7..19 (straddles both bounds)    → true   (partial overlap = edit intent)
// caret 8 / caret 18 (boundaries)            → true   (unchanged, root cause C)
// selection 8..18 exactly                    → false  (exact cover counts as covered)
```

In `view.test.ts` (real-EditorView smoke section), add:

```ts
it("keeps a block widget mounted when a selection fully covers it", async () => {
  const doc = "intro\n\n```ts\nconst a = 1\n```\n\noutro\n"
  // build view the same way neighboring smoke tests do (makeState + new EditorView)
  // 1) caret outside → .omd-block exists
  // 2) dispatch selection {anchor: 0, head: doc.length} → .omd-block STILL exists
  // 3) the wrap element has class omd-block-covered
  // 4) dispatch caret into the block (lineAt of fence+1) → .omd-block is null
  // 5) dispatch caret outside again → .omd-block exists again, covered class gone
})
```

(Match the file's existing view-lifecycle helpers — several tests there already mount/dismount `EditorView` in happy-dom; reuse their setup/teardown pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- blockwidgets` and `pnpm test -- view.test`
Expected: FAIL — full-cover selection currently returns true → widget unmounts, `.omd-block` is null, no covered class.

- [ ] **Step 3: Implement blockSelected + overlay**

`blockWidget.ts`:

```ts
// 光标/选区与 [from, to] 重叠（含边界）且**未完整包含**→ 块处于编辑态（显示源码）。
// 完整包含（sel.from <= from && sel.to >= to，Cmd+A / 跨块拖选 / Shift+↓ 跨块）
// 保持渲染 + 选中态覆盖（Typora 语义：选区是视觉的，光标才是编辑）。
// 光标含边界算块内（root cause C）：敲完 closing fence 光标恰停在 node.to。
export function blockSelected(state: EditorState, from: number, to: number) {
  const { from: sf, to: st } = state.selection.main
  const overlaps = sf <= to && st >= from
  const fullyCovers = sf <= from && st >= to
  return overlaps && !fullyCovers
}
```

Registration in `BlockWidget` — add to `toDOM` after `wrap` is built: `registerBlockWidget(this, wrap)`; in `destroy`: `unregisterBlockWidget(this)`.

New file `blockSelectionOverlay.ts`:

```ts
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import type { BlockWidget } from "./blockWidget"
import { blockSelected } from "./blockWidget"

const live: { widget: BlockWidget; dom: HTMLElement }[] = []

export function registerBlockWidget(widget: BlockWidget, dom: HTMLElement) {
  live.push({ widget, dom })
}

export function unregisterBlockWidget(widget: BlockWidget) {
  const i = live.findIndex(e => e.widget === widget)
  if (i >= 0) live.splice(i, 1)
}

const COVERED = "omd-block-covered"

function refresh(view: EditorView) {
  for (const { widget, dom } of live) {
    if (!dom.isConnected) continue
    let from: number
    try { from = view.posAtDOM(dom) } catch { continue }
    const covered = !blockSelected(view.state, from, from + widget.src.length)
      && view.state.selection.main.from <= from
      && view.state.selection.main.to >= from + widget.src.length
    dom.classList.toggle(COVERED, covered)
  }
}

/** 选区变化时给“被完整包含”的存活块 widget 切换选中态覆盖类。纯 DOM，不产装饰。 */
export const blockSelectionOverlay = ViewPlugin.fromClass(class {
  update(u: ViewUpdate) { if (u.selectionSet || u.docChanged || u.viewportChanged) refresh(u.view) }
})
```

Wire into `modes/livePreview.ts` `livePreviewExt()` return array (append `blockSelectionOverlay`; import from `../decorations/blockSelectionOverlay`).

`apps/desktop/src/styles.css` — next to the existing `.omd-block` rules (~L176):

```css
.omd-block { position: relative; }  /* merge into existing rule, don't duplicate */
.omd-block.omd-block-covered::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--omd-selection-bg, rgba(119, 172, 255, 0.25));
  pointer-events: none;
}
```

(Match the actual selection color used by `cm-selectionBackground` styling in that file; if there is a variable, use it; otherwise keep the fallback literal and add `--omd-selection-bg` to both light/dark `:root`/theme blocks consistent with existing `--omd-*` variables.)

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test` and `pnpm --filter @omd/desktop test && pnpm --filter @omd/desktop build`
Expected: PASS. Watch specifically for `view.test.ts` "keeps block click position correct after inserting before the widget" and tables tests — their selections are caret/partial so semantics are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/decorations/blockWidget.ts packages/engine/src/decorations/blockSelectionOverlay.ts packages/engine/src/modes/livePreview.ts packages/engine/test/blockwidgets.test.ts packages/engine/test/view.test.ts apps/desktop/src/styles.css
git commit -m "fix: keep block widgets rendered with a covered overlay when a selection fully spans them"
```

---

### Task 3: Inline marks stay folded for non-caret selections

**Files:**
- Modify: `packages/engine/src/decorations/types.ts:11-28` (nearCursor, cursorInside)
- Test: `packages/engine/test/inlineMarks.test.ts`, `packages/engine/test/blocks.test.ts` (verify existing), `packages/engine/test/inline.test.ts`

**Interfaces:**
- Produces: `nearCursor(state, from, to)` → returns true only when the **collapsed** caret's line overlaps the mark. `cursorInside(state, from, to)` → true only for a collapsed caret position inside `[from, to)` (boundary-inclusive start). Signatures unchanged; all call sites (`markActive` inline.ts:31-33, `listMarkActive` blocks.ts:196-198, `foldQuoteMark`, `foldQuotedFenceMark`, HeaderMark branch inline.ts:94, Entity/Emoji/InlineMath checks) follow automatically.

- [ ] **Step 1: Write the failing tests**

In `inlineMarks.test.ts` add (mirroring the file's existing spec-list assertion style):

```ts
it("keeps emphasis marks folded while a non-caret selection crosses them", () => {
  const doc = "plain **bold** plain"
  // selection {anchor: 0, head: doc.length} → specs contain replace:EmphasisMark (still folded)
  // and mark:omd-strong still present
  // caret at the "b" of bold → replace:EmphasisMark absent (revealed) — regression guard
})

it("keeps the heading mark folded while its line is selected", () => {
  const doc = "# Title\nbody\n"
  // non-empty selection covering line 1 entirely → replace:HeaderMark present
  // caret on line 1 → replace:HeaderMark absent (unchanged)
})
```

In `blocks.test.ts` add one quote analog:

```ts
it("keeps the quote mark folded under a non-caret line selection", () => {
  const doc = "> quoted text\n"
  // selection spanning the whole line → replace:QuoteMark present
  // caret inside the quote content (past "> ") → still folded (cursorInside semantics)
  // caret inside the "> " itself → revealed (cursorInside start-inclusive)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- inlineMarks` and `pnpm test -- blocks`
Expected: FAIL — current `cursorInside` non-empty branch (`sf < to && st > from`) reveals marks for crossing selections; current `nearCursor` reveals the head line.

- [ ] **Step 3: Implement**

`types.ts` — replace both functions:

```ts
// Typora model: folds are visual; only the caret reveals source. A non-empty
// selection (drag, Shift+arrows, Cmd+A) never expands marks — that both keeps
// previews stable during drags and stops reveal-flicker from relayouting lines
// mid-selection (which used to push endpoints across newlines).
export function nearCursor(state: EditorState, from: number, to: number) {
  const sel = state.selection.main
  if (!sel.empty) return false
  const cursorLine = state.doc.lineAt(sel.head)
  return cursorLine.from <= to && cursorLine.to >= from
}

// Collapsed caret within [from, to) (start-boundary inclusive — typing the
// closing fence leaves the caret exactly at `to`, which is "past" the mark).
// Non-caret selections return false; there is no reveal for visual selection.
export function cursorInside(state: EditorState, from: number, to: number): boolean {
  const { from: sf, to: st } = state.selection.main
  return sf === st && sf >= from && sf < to
}
```

- [ ] **Step 4: Run full engine suite; fix expectations that encoded the old behavior**

Run: `pnpm test`
Expected: mostly PASS. Audit any failures individually: tests that deliberately used non-caret selections to reveal marks encode the old behavior and must be updated to use carets (do NOT weaken caret-boundary cases — they guard root cause C / the M2 incident). Known likely candidates from exploration: `blocks.test.ts:86` "keeps nested quote marks folded when the whole line is selected" (expected folded — now even more so, should still pass); `inline.test.ts:130,166` (collapsed caret cases — unaffected); snapshot tests using triple-click semantics (the old whole-line special case in `cursorInside` L25-27 becomes dead code — remove it with this change).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/decorations/types.ts packages/engine/test/inlineMarks.test.ts packages/engine/test/blocks.test.ts
git commit -m "fix: only a collapsed caret reveals inline markdown marks, selections stay visual"
```

---

### Task 4: Arrow keys enter blocks line by line

**Files:**
- Create: `packages/engine/src/navigation/blockEntry.ts`
- Modify: `packages/engine/src/modes/livePreview.ts` (livePreviewExt array)
- Test: `packages/engine/test/navigation.test.ts` (already exists — extend)

**Interfaces:**
- Produces: `blockEntryPosition(state: EditorState, blockFrom: number, blockTo: number, dir: 1 | -1): number` — pure. Down (1): first content line start (`doc.lineAt(blockFrom).to + 1`, clamped ≤ blockTo); Up (-1): last content line start (`doc.lineAt(blockTo - 1).from`).
- Produces: `blockMotionKeymap: Extension` — `Prec.high(keymap.of([{key: "ArrowUp", run}, {key: "ArrowDown", run}]))`; commands only act on collapsed selections adjacent to a widget block, else return false so default motion runs.

- [ ] **Step 1: Write the failing test**

In `navigation.test.ts` (pure-state tests; check its imports — it tests `footnotesNav` today, so add a new describe block):

```ts
import { blockEntryPosition } from "../src/navigation/blockEntry"

describe("blockEntryPosition", () => {
  const doc = "para\n\n```ts\nline1\nline2\n```\n\nafter\n"
  // block fence spans 6..29 (compute from doc.indexOf("```") to indexOf("```", 3) + 3 in the test itself)
  it("down enters the first content line", () => {
    expect(blockEntryPosition(state, from, to, 1)).toBe(state.doc.lineAt(from).to + 1)
  })
  it("up enters the last content line", () => {
    expect(blockEntryPosition(state, from, to, -1)).toBe(state.doc.lineAt(to - 1).from)
  })
  it("clamps on degenerate single-line blocks", () => {
    // e.g. "---" hr block: from..to on one line — down returns min(lineAt(from).to + 1, to), never > to
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- navigation`
Expected: FAIL — module `../src/navigation/blockEntry` does not exist.

- [ ] **Step 3: Implement blockEntry.ts**

```ts
import type { EditorState } from "@codemirror/state"
import { BlockType, EditorView, Prec, keymap } from "@codemirror/view"

/**
 * ↑/↓ 逐行进入渲染块（CM 的垂直移动会整块跳过 widget 块：posAtCoords 的 scanY
 * 路径把非文本块整体让开 — discuss.codemirror.net/t/9491，作者建议自定义命令）。
 * 进入即触发 blockSelected → widget 卸载显源码，与鼠标点击同一条路径；
 * 离开后 widget 重新挂载。Shift+↑/↓ 不拦截：跨块扩展选区应“盖过”渲染块
 * （见 blockSelectionOverlay），而不是进源码。
 */

export function blockEntryPosition(state: EditorState, blockFrom: number, blockTo: number, dir: 1 | -1): number {
  if (dir === 1) return Math.min(state.doc.lineAt(blockFrom).to + 1, blockTo)
  return state.doc.lineAt(blockTo - 1).from
}

function adjacentWidgetBlock(view: EditorView, dir: 1 | -1): { from: number; to: number } | null {
  const head = view.state.selection.main.head
  // 目标 y = 当前行底/顶 ± 半行高，绕过行内 padding 命中相邻块
  const rect = view.coordsAtPos(head)
  if (!rect) return null
  const half = view.defaultLineHeight / 2
  const y = (dir === 1 ? rect.bottom + half : rect.top - half) - view.documentTop
  if (y < 0) return null
  const block = view.elementAtHeight(y)
  if (block.type === BlockType.Text) return null
  if (dir === 1 ? block.from <= head : block.to > head) return null  // 必须是光标行之外的块
  return { from: block.from, to: block.to }
}

function enterBlock(dir: 1 | -1) {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main
    if (!sel.empty) return false
    const block = adjacentWidgetBlock(view, dir)
    if (!block) return false
    const pos = blockEntryPosition(view.state, block.from, block.to, dir)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    return true
  }
}

/** Prec.high：desktop 的 defaultKeymap 先于 editorExtensions 注册，后注册的
 * keymap 优先级更高需要显式提级（Enter/Tab 同例，format/lists.ts）。仅 Live 模式挂载。 */
export const blockMotionKeymap = Prec.high(keymap.of([
  { key: "ArrowDown", run: enterBlock(1) },
  { key: "ArrowUp", run: enterBlock(-1) },
]))
```

Wire into `livePreviewExt()` in `modes/livePreview.ts` (append `blockMotionKeymap`).

Guard check: verify `view.elementAtHeight(y)` expects document-relative y (it does — it takes height from document top) and that `documentTop` accounts for content offset; adjust with `view.documentTop` vs `view.contentDOM.getBoundingClientRect().top` per the actual API (test in the running app via manual QA since happy-dom has no layout).

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (new pure tests + full suite). `modes.test.ts` asserts `livePreviewExt()` contents — update its expected extension list if it enumerates them.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/navigation/blockEntry.ts packages/engine/src/modes/livePreview.ts packages/engine/test/navigation.test.ts packages/engine/test/modes.test.ts
git commit -m "fix: arrow keys step into rendered blocks line by line instead of skipping them"
```

---

### Task 5: Documentation and full verification

**Files:**
- Modify: `packages/engine/AGENTS.md` (invariant 5 rewrite, pitfalls), `docs/memory/known-gotchas.md`, `docs/manual-qa.md`

- [ ] **Step 1: Update engine AGENTS.md**

Decoration and Widget Invariants: rewrite item 5 to: "Treat a block as editable when the selection overlaps its source range **including both boundaries** *and does not fully cover it*. A selection fully covering the block (Cmd+A, drag across, Shift+↓) keeps the widget rendered with the `omd-block-covered` overlay; only a caret entering (or a partial selection poking into) the block reveals source." Add to Common Pitfalls: "ArrowUp/ArrowDown are engine-owned (`navigation/blockEntry.ts`) and need `Prec.high`; pointer selection must never cascade across lines, so line-start and cross-line atoms stay out of `atomicRanges` (Rule 3 in known-gotchas)."

- [ ] **Step 2: Update known-gotchas.md**

- atomicRanges entry: add Rule 3 (line-start `from === line.from` and cross-line `to > line.to` atoms excluded; mechanism: `skipAtomsForSelection` loop + pointer selection sync; symptom "clicking a line highlights the next one").
- Update the L20 selection-rebuild entry's blockSelected description (full-cover ≠ edit intent).
- New entry: "Selection is visual, the caret is editing" — nearCursor/cursorInside return false for non-empty selections; block widgets stay mounted under a covering selection with `omd-block-covered`; arrow keys enter blocks via `blockMotionKeymap`.

- [ ] **Step 3: Update manual-qa.md**

In 「编辑核心」 add checkboxes:
- ↑/↓ 从块上下相邻行进入代码块/表格/公式块：落点为块内首/末内容行，源码显现，再按离开后恢复渲染
- Cmd+A：全文保持渲染形态（表格/公式/代码块不显源码），仅选中高亮（omd-block-covered 覆盖）
- 跨表格/公式拖选：保持渲染，不露出 `|`/`$$` 源码；松开后选区高亮收尾正常
- 点击标题行选中文字：不连带高亮下一行；拖选扫过 `**粗体**`/链接时保持渲染
- Shift+↓ 从标题行跨入下方块：选区盖过渲染块（不显源码）

- [ ] **Step 4: Full verification**

Run: `pnpm verify` (test.sh + build.sh — engine + desktop + cargo, links the Rust binary)
Expected: all green. Note: `pnpm verify` does not lint/format — do not claim it did.

- [ ] **Step 5: Commit and merge**

```bash
git add packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/manual-qa.md
git commit -m "docs: record selection-is-visual invariants, atomic Rule 3, and block-entry QA items"
```

Then report the branch (`fix/selection-wysiwyg-block-nav` in `.worktrees/selection-wysiwyg`) for review — merging back to main is the user's call (finishing-a-development-branch skill at that point).
