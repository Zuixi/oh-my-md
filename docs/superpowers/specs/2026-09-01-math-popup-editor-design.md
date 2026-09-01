# Math Popup Editor Design

Date: 2026-09-01

Status: Approved

## 1. Problem

In Live Preview, clicking a rendered math block (`$$...$$`) currently replaces
the widget with raw source (the standard `blockSelected` edit path). The user
wants an Obsidian/Typora-style interaction instead:

1. Hovering a math widget highlights it with a background and shows a pointer cursor.
2. Clicking opens an editor popup directly below the block (not a source reveal).
3. The rendered formula above the popup re-renders live while the TeX is edited.

Phase 1 scope: `MathBlockWidget` popup editing plus hover affordances for both
block and inline math. Inline-math popups are phase 2 (out of scope here).

## 2. Chosen mechanism: identity-stable widget (not draft mode)

The rejected alternative ("draft mode") holds edits in a popup-local draft and
dispatches once on close. It loses per-keystroke undo, hides in-flight content
from autosave/recovery/watchers, and needs draft-loss handling.

Adopted mechanism uses CodeMirror's mutable-widget contract
(`@codemirror/view@6.43.8`, `WidgetType.updateDOM(dom, view, from): boolean`):

- `MathBlockWidget.eq()` compares `src` **and** embed position data.
- CodeMirror's `findWidget` has two passes: pass 0 reuses a tile AS-IS when
  `compare`/`eq` succeeds — `updateDOM` is NEVER called; pass 1 (only reached
  when pass 0 failed for every tile) reuses the tile DOM by constructor match
  and calls `updateDOM(dom, view, oldWidget)` on the incoming widget.
- Each keystroke dispatches a real document change rewriting the `$$...$$`
  block text. The decoration diff finds `eq() === false` for the changed
  content, pass 1 keeps the existing DOM (popup, textarea, focus all survive)
  and calls `updateDOM`, which re-renders the KaTeX preview in place.
- Returning `false` from `updateDOM` falls back to a full redraw — the safety
  net for any state the in-place path cannot handle.

Consequences (all intended):

- Document is always the truth: undo/redo per keystroke, autosave/recovery,
  watchers, and external-change mapping behave like ordinary typing.
- Popup close is just close — no commit/discard ambiguity, no data-loss path.
- Read-only documents reject popup edits through the normal dispatch path.

Invariant: because pass 0 skips `updateDOM` entirely, `eq()` returning true
for changed content would silently freeze the preview — `eq` must fail when
`src` changed, making `updateDOM` the in-place refresh path. Fresh state (the
latest `src`) is taken from the incoming widget instance inside `updateDOM`;
the popup's `ResizeObserver` is disconnected on Escape/blur close and in
`destroy()`.

## 3. Component behavior

### 3.1 BlockWidget hook

`BlockWidget.toDOM` today early-returns `view.focus()` when
`enterSourceOnClick()` is false (the code-block path). A new protected hook
`onWrapClick(view, wrap)` is invoked instead; its default implementation calls
`view.focus()`, preserving code-block behavior exactly. `MathBlockWidget`
overrides `enterSourceOnClick()` to return false and `onWrapClick` to open the
popup.

### 3.2 Popup

- Created inside the widget wrap (in-flow, below the body) on first click;
  CM measures it through the normal block-widget measure path.
- Contains one `<textarea>` prefilled with the current TeX (delimiters
  stripped, trimmed for display).
- `input` → rebuild block source preserving delimiter shape (multiline
  `$$\n...\n$$` if the original contained a newline, else single-line
  `$$...$$`) → dispatch replacement of the whole block range. The range is
  resolved from the live document — the enclosing `MathBlock` syntax node at
  `posAtDOM(wrap)`, with `blockWidgetRange` as secondary fallback — and
  **never** from constructor offsets. If no live range resolves, the
  write-back is dropped (bounded, self-healing on the next keystroke)
  rather than guessed.
- Preview rendering is coalesced with `requestAnimationFrame`: at most one
  KaTeX render per frame during fast typing.
- `Escape` closes the popup and returns focus to the editor. `blur` (focus
  leaving the popup subtree) closes it. Closing never dispatches — the
  document already holds the latest text. Because the widget is only mounted
  when the selection is outside the block, restoring focus cannot flip the
  block into its source-edit state.
- Clicking the rendered formula while the popup is open refocuses the textarea.
- Read-only views: popup is not opened; `view.focus()` keeps existing behavior.
- Keyboard entry into the block range (arrow keys) still reveals source via the
  unchanged `blockSelected` path — mouse and keyboard entry coexist.

### 3.3 Live preview rendering

- `updateDOM` (pass 1 — only reached when `eq` failed) re-renders KaTeX into
  the existing `.omd-block-body` and calls `view.requestMeasure()` after the
  async render settles. It also re-syncs the popup textarea whenever its value
  differs from the document tex — no focus guard, so Undo/Redo or external
  edits while the popup is open re-sync it; during normal typing the
  dispatched write-back makes the sync a no-op (no caret jump).
- The update path renders with `throwOnError: false` so half-written formulas
  show KaTeX's inline red error markup instead of destroying the block.
- First mount keeps today's behavior: `throwOnError: true`, base-class
  `⚠ error + source` fallback.

### 3.4 Event handling

`MathBlockWidget` extends `ignoreEvent` the same way `TableWidget` does:
ignore `keydown/keyup/keypress/input/click` in addition to the base
`mousedown/dblclick`, so typing in the popup textarea never reaches CM's
keymap or selection logic.

### 3.5 CSS (desktop owns styles)

- `.editor-host .omd-math { cursor: pointer; }` and
  `.editor-host .omd-block.omd-math:hover { background: var(--omd-code-bg); }`
  (existing token, rounded corners).
- `.editor-host .omd-inline-math:hover` gets the same background token and
  pointer cursor.
- `.omd-math-popup` / `.omd-math-editor`: border, monospace font,
  `resize: vertical`; manual resize triggers `view.requestMeasure()` via a
  `ResizeObserver`.

## 4. Acceptance

- Per-keystroke editing: document updates live, widget DOM node is reused
  (same node identity), preview updates, no source flash.
- Undo/redo works per keystroke.
- Read-only document: no popup.
- Hover highlight and pointer cursor apply to both block and inline math.
- Existing engine/desktop suites and advisory benchmarks pass with no new
  warning categories.
- `docs/manual-qa.md` records the interaction change;
  `packages/engine/AGENTS.md` records the identity-stable widget contract.

## 5. Rollback

Each part is independently revertible: CSS-only hover rules; the `onWrapClick`
hook (default preserves old behavior); the math widget popup + identity-stable
eq. Commits follow these boundaries.