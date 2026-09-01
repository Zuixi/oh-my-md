# Editor Interaction and Layout Reliability Design

Date: 2026-09-01

Status: Approved

## 1. Scope

This delivery fixes four related editor-surface defects without changing
Markdown syntax, document text, or the settings schema:

1. A math popup textarea keeps focus but cannot place its caret with a mouse.
2. The document cannot scroll past its final line, leaving the last lines pinned
   to the bottom edge.
3. The selected Font Family applies to prose but not inline code, source-style
   code blocks, rendered Shiki code blocks, or the math popup editor.
4. The readable editor column is narrower than intended on desktop displays.

The changes are limited to the existing CodeMirror widget event path and the
desktop-owned editor theme/CSS. No new dependency, preference, parser rule, or
IPC contract is introduced.

## 2. Confirmed root causes

### 2.1 Math popup pointer placement

`BlockWidget.toDOM()` handles every bubbling left-button `mousedown` on the
widget wrapper. For widgets whose click does not enter raw source, it calls
`preventDefault()` before delegating to `onWrapClick()`.

That cancellation is necessary when clicking the rendered math preview for the
first time: without it, WKWebView performs its default focus action after the
handler, steals focus from the newly-created textarea, and the popup's blur
handler immediately closes it.

The same wrapper listener also receives `mousedown` events that originate
inside the already-open `.omd-math-popup`. Cancelling those events disables the
textarea's native hit-testing and selection behavior. The textarea remains
focused, so arrow keys move the caret, but clicking another character cannot
change `selectionStart`.

The previous regression test asserted that the outer math-block event was
cancelled, but did not distinguish an outer preview click from an inner popup
click.

### 2.2 Missing scroll-past-end space

The CodeMirror scroller uses ordinary `overflow: auto`; `.cm-content` has only
`16px 24px` padding. Its scroll height therefore ends just after the final
document line. There is no scroll-past-end extension or viewport-sized trailing
space.

### 2.3 Code fonts ignore Font Family

The application correctly writes the selected font to `--omd-font-family`, and
`.cm-content` consumes it. Code-specific selectors then override that inherited
value with `ui-monospace, monospace`. Rendered Shiki `<pre>` content additionally
falls back to the browser's native `<pre>` monospace style because its code
container does not explicitly inherit the editor font.

### 2.4 Narrow readable column

The column width is intentionally fixed to the shared constant and CSS variable
`CONTENT_MAX_WIDTH = 780` / `--omd-content-width: 780px`. No sizing calculation
is failing; the chosen default is simply too narrow for the desired desktop
layout.

## 3. Chosen design

### 3.1 Preserve native pointer behavior inside interactive widget controls

The shared `BlockWidget` wrapper remains responsible for cancelling the outer
preview `mousedown`, because that protects the newly-opened popup from the
WKWebView focus race. It must not cancel events whose target belongs to an
interactive descendant that owns native pointer selection.

`MathBlockWidget` will identify events originating inside
`.omd-math-popup` as widget-owned native interactions. The shared wrapper will
return before `preventDefault()` and before re-running `onWrapClick()` for those
events. This keeps the fix scoped to the math popup rather than weakening the
source-entry behavior of tables, Mermaid, horizontal rules, or future block
widgets.

The behavior contract is:

- First left-click on the rendered math preview: cancel the outer default,
  create the popup, focus the textarea.
- Left-click within the textarea: do not cancel; the browser places or extends
  the textarea selection normally.
- Clicking the rendered preview while the popup is already open: cancel the
  outer default and refocus the existing textarea.
- Escape and outside blur retain their existing close behavior.
- Read-only views retain their existing no-popup behavior.

The event check is structural (`closest(".omd-math-popup")`), not a special case
for `HTMLTextAreaElement`, so dragging the textarea scrollbar or clicking future
popup controls also keeps native behavior.

### 3.2 Add CSS-only scroll-past-end space

The editor will provide trailing scroll room through `.cm-content` bottom
padding rather than inserting blank Markdown lines or dispatching synthetic
changes. The top and horizontal padding stay unchanged; the bottom padding
becomes viewport-relative with a small fixed floor:

```css
padding: 16px 24px max(16px, 50vh);
```

This allows the final line to move to approximately the middle of the viewport,
which is sufficient to expose surrounding context without the excessive empty
canvas of a full-screen spacer.

The padding remains inside CodeMirror's measured content box. No vertical
margin is added to block widgets, and no extra DOM block decoration is mounted,
so existing height-map and click-coordinate invariants remain intact.

`Editor.ts` remains the owning source for the `.cm-content` theme declaration;
desktop CSS tests will guard the viewport-relative bottom value. The vendored
tight-selection formulas already account for `.cm-content` padding. Existing
selection geometry tests must be rerun because they deliberately pin the
content padding contract.

### 3.3 Treat Font Family as the font for all editable document content

The existing setting remains a single Font Family setting. It applies to prose
and code rather than introducing a second code-font preference.

Desktop CSS will replace code-area hard-coded font stacks with the existing
variable:

```css
font-family: var(--omd-font-family, ui-monospace, monospace);
```

This applies to:

- `.omd-inline-code`
- line-styled `.omd-codeblock` source editing
- rendered `.omd-code pre` / `.omd-code pre code`
- `.omd-math-editor`

Where a shorthand `font:` currently embeds a fixed family in an editor-owned
source placeholder or fallback, only the family portion will be changed to the
same variable while preserving size and line height.

Shiki continues to own token colors, font style, and font weight. The selected
family changes glyph rendering only; no Shiki HTML generation or cache key
changes are needed.

This delivery deliberately does not change exported HTML fonts. Export is a
source projection with its own stable standalone stylesheet and does not carry
application preferences today.

### 3.4 Widen the default readable column to 900px

The named cross-layer value changes from 780 to 900 in both of its existing
homes:

- `CONTENT_MAX_WIDTH` in `apps/desktop/src/constants.ts`
- `--omd-content-width` in light and dark root CSS declarations

`Editor.ts` continues to consume the constant as its fallback. The existing
cross-layer drift test remains the guard; no new setting is added.

A 900px maximum keeps long prose readable while using desktop windows more
efficiently. Narrow windows remain responsive because `max-width` never forces
the content wider than its containing scroller.

## 4. Ownership and files

### Engine

- `packages/engine/src/decorations/blockWidget.ts`
  - provide the minimal event-routing hook needed to let a subclass preserve
    native descendant `mousedown` behavior before the wrapper cancellation.
- `packages/engine/src/decorations/widgets/math.ts`
  - classify `.omd-math-popup` descendants as native interactions.
- `packages/engine/test/mathPopup.test.ts`
  - distinguish cancelled outer clicks from uncancelled popup/textarea clicks.

The engine remains React- and desktop-i18n-free.

### Desktop

- `apps/desktop/src/Editor.ts`
  - viewport-relative bottom padding for scroll-past-end.
- `apps/desktop/src/constants.ts`
  - change the named width default to 900.
- `apps/desktop/src/styles.css`
  - update the shared width variable and code-family inheritance rules.
- Existing focused CSS/theme tests under `apps/desktop/test/`
  - guard width drift, scroll padding, and code font inheritance.
- `docs/manual-qa.md`
  - add mouse caret placement, scroll-past-end, selected code font, and 900px
    layout checks.

## 5. Testing strategy

### Automated engine checks

A real `EditorView` math-popup test must verify:

1. Outer preview `mousedown` is cancelable and becomes `defaultPrevented`.
2. Popup is created and the textarea receives focus.
3. A bubbling `mousedown` dispatched on the textarea is not
   `defaultPrevented`.
4. Existing input write-through, DOM reuse, Escape, read-only, and undo tests
   continue to pass.

Happy DOM cannot prove browser pixel-to-character hit-testing, but the event
cancellation state is the exact contract that previously disabled it. Manual
WKWebView QA remains required for actual click placement and drag selection.

### Automated desktop checks

Focused tests will assert:

- `CONTENT_MAX_WIDTH` and both CSS declarations equal 900px.
- `.cm-content` keeps 16px top / 24px horizontal padding and has a
  viewport-relative bottom padding of 50vh with a 16px floor.
- Inline code, line-styled code blocks, rendered Shiki code, and the math popup
  resolve through `--omd-font-family` rather than a fixed family.
- Existing block-widget no-margin and tight-selection guards remain unchanged.

### Required verification

```sh
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

No Rust command changes are involved.

### Manual QA

In `pnpm dev` / the Tauri app:

- Open a math popup, click near the start/middle/end of a multiline formula,
  type one character, and confirm insertion occurs at the clicked position;
  drag-select with the mouse and replace the selection.
- Scroll a short and a long document to the end; confirm the final line can move
  to approximately mid-viewport and remains clickable/editable.
- Select JetBrains Mono (or another visibly distinct installed family); confirm
  prose, inline code, source-style code lines, rendered Shiki blocks, and the
  math textarea all change family.
- At a wide desktop window, confirm the centered column reaches 900px; narrow
  windows must not gain horizontal page overflow.

## 6. Compatibility and rollback

- The math event change is local to interactive descendants explicitly opted in
  by a widget; other block click semantics remain unchanged.
- Scroll-past-end is CSS-only and never changes source text or undo history.
- Font changes consume the existing preference and add no migration.
- Width rollback is a single named constant plus the paired CSS variable values.

Each behavior can be reverted independently if manual WKWebView QA finds a
platform-specific regression.

## 7. Out of scope

- A separate code-font preference.
- User-configurable editor column width.
- Full-screen scroll-past-end or configurable scroll percentage.
- Inline-math popup editing.
- Exported HTML/PDF font preference propagation.
- Workspace file visibility, runtime i18n completion, and installer reliability;
  those remain separate approved deliveries with their own specs and plans.
