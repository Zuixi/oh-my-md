# Editor Interaction and Layout Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore native mouse caret placement in the math popup, add scroll-past-end space, make code honor the selected font, and widen the readable editor column to 900px.

**Architecture:** Keep the math fix in the shared block-widget event boundary with a subclass opt-in for native descendant interactions. Keep layout and typography changes desktop-owned through the existing CodeMirror theme, named width constant, and CSS variables; do not modify Markdown source, settings persistence, exports, or IPC.

**Tech Stack:** TypeScript, CodeMirror 6, Vitest with happy-dom, desktop CSS, React/Tauri host assembly.

**Spec:** `docs/superpowers/specs/2026-09-01-editor-interaction-layout-reliability-design.md`

## Global Constraints

- The first rendered-math preview `mousedown` must still be cancelled so WKWebView cannot steal focus and immediately blur-close the newly-created popup.
- A `mousedown` originating inside `.omd-math-popup` must not be cancelled and must not rerun the outer preview click action.
- The native-interaction exemption must be opt-in and must not alter table, Mermaid, horizontal-rule, or ordinary source-entry widget behavior.
- Scroll-past-end must be CSS/theme-only: no inserted Markdown, synthetic transaction, block margin, or new block decoration.
- `.cm-content` keeps 16px top padding, 24px horizontal padding, and uses `max(16px, 50vh)` bottom padding.
- The existing Font Family setting applies to prose, inline code, line-styled code blocks, rendered Shiki code, source placeholders/fallbacks, and the math popup editor.
- Shiki continues to own token color/style/weight; exported HTML fonts remain unchanged.
- `CONTENT_MAX_WIDTH` and both `--omd-content-width` declarations must be exactly `900px` and remain drift-tested.
- No new dependency, preference, parser rule, settings migration, engine-to-desktop import, or IPC change.
- Do not edit or commit unrelated files from other worktrees or plans.

---

### Task 1: Preserve Native Pointer Selection Inside the Math Popup

**Files:**
- Modify: `packages/engine/src/decorations/blockWidget.ts:65-90`
- Modify: `packages/engine/src/decorations/widgets/math.ts:75-90`
- Test: `packages/engine/test/mathPopup.test.ts:45-70`

**Interfaces:**
- Produces: `BlockWidget.nativePointerInteraction(event: MouseEvent): boolean`, a protected hook whose default is `false`.
- Consumes: `MathBlockWidget` uses the hook to recognize targets within `.omd-math-popup`.
- Preserves: `enterSourceOnClick()` and `onWrapClick(view, wrap)` behavior for every existing widget.

- [ ] **Step 1: Write the failing popup-pointer regression test**

Update the math popup test helper so the outer preview event remains asserted as cancelled, then add a focused test:

```ts
it("leaves textarea mousedown native so the mouse can place the caret", async () => {
  const { view, errors } = makeView(DOC)
  await tick()
  clickBlock(view)
  const ta = view.dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")!
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  })

  ta.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(false)
  expect(view.dom.querySelector(".omd-math-popup")).toBeTruthy()
  expect(document.activeElement).toBe(ta)
  expect(errors.map(String)).toEqual([])
  view.destroy()
})
```

- [ ] **Step 2: Run the test and verify the current wrapper cancellation fails it**

Run:

```sh
pnpm --filter @omd/engine exec vitest run test/mathPopup.test.ts
```

Expected: FAIL because the bubbling textarea `mousedown` has `defaultPrevented === true`.

- [ ] **Step 3: Add the minimal protected hook and route before cancellation**

In `BlockWidget`, add:

```ts
protected nativePointerInteraction(_event: MouseEvent): boolean { return false }
```

In the wrapper listener, immediately after the left-button guard and before either `preventDefault()` call, add:

```ts
if (this.nativePointerInteraction(e)) return
```

Do not move or remove the existing outer-preview `preventDefault()`.

- [ ] **Step 4: Opt MathBlockWidget into popup descendant events**

Add this override to `MathBlockWidget`:

```ts
protected nativePointerInteraction(event: MouseEvent) {
  return event.target instanceof Element
    && event.target.closest(".omd-math-popup") !== null
}
```

This structural check covers textarea selection, scrollbar dragging, and future popup controls.

- [ ] **Step 5: Run focused and full engine verification**

Run:

```sh
pnpm --filter @omd/engine exec vitest run test/mathPopup.test.ts test/view.test.ts
pnpm test
```

Expected: all focused tests pass; full engine suite reports zero failures.

- [ ] **Step 6: Commit**

```sh
git add packages/engine/src/decorations/blockWidget.ts \
  packages/engine/src/decorations/widgets/math.ts \
  packages/engine/test/mathPopup.test.ts
git commit -m "fix: allow mouse caret placement in math popup"
```

---

### Task 2: Add Scroll-Past-End and Widen the Readable Column

**Files:**
- Modify: `apps/desktop/src/Editor.ts:220-228`
- Modify: `apps/desktop/src/constants.ts:30-31`
- Modify: `apps/desktop/src/styles.css:1-52`
- Test: `apps/desktop/test/Editor.test.ts`
- Test: `apps/desktop/test/crossLayerConstants.test.ts:90-98`

**Interfaces:**
- Produces: the existing `CONTENT_MAX_WIDTH` constant with value `900`.
- Produces: the existing `--omd-content-width` CSS variable with `900px` in both light and dark declarations.
- Produces: CodeMirror `.cm-content` padding string `16px 24px max(16px, 50vh)`.
- Preserves: the existing max-width variable/fallback and centered `margin: 0 auto` layout.

- [ ] **Step 1: Write failing width and scroll-padding assertions**

In `crossLayerConstants.test.ts`, strengthen the existing width test:

```ts
it("uses the approved 900px readable column width", () => {
  expect(CONTENT_MAX_WIDTH).toBe(900)
  expect(STYLES_CSS.match(/--omd-content-width:\s*900px;/g)).toHaveLength(2)
})
```

In `Editor.test.ts`, add:

```ts
it("keeps half a viewport of trailing scroll space without changing horizontal padding", () => {
  const source = readFileSync(resolve(process.cwd(), "src/Editor.ts"), "utf8")
  expect(source).toContain('padding: "16px 24px max(16px, 50vh)"')
  expect(source).toContain('margin: "0 auto"')
})
```

- [ ] **Step 2: Run the focused desktop tests and verify they fail for 780px/fixed padding**

Run:

```sh
pnpm --filter @omd/desktop exec vitest run test/Editor.test.ts test/crossLayerConstants.test.ts
```

Expected: FAIL because the width is 780 and the padding is `16px 24px`.

- [ ] **Step 3: Change the named width and paired CSS values**

Set:

```ts
export const CONTENT_MAX_WIDTH = 900
```

Change both root theme declarations to:

```css
--omd-content-width: 900px;
```

Do not add a second width literal elsewhere.

- [ ] **Step 4: Add viewport-relative bottom padding in the CodeMirror theme**

Change the `.cm-content` declaration in `Editor.ts` to:

```ts
padding: "16px 24px max(16px, 50vh)",
```

Keep the existing max width and centered margin unchanged.

- [ ] **Step 5: Run focused desktop tests**

Run:

```sh
pnpm --filter @omd/desktop exec vitest run test/Editor.test.ts \
  test/crossLayerConstants.test.ts test/tightSelection.test.ts
```

Expected: all pass. `tightSelection.test.ts` confirms selection geometry remains compatible with content padding.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/Editor.ts apps/desktop/src/constants.ts \
  apps/desktop/src/styles.css apps/desktop/test/Editor.test.ts \
  apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: improve editor scrolling and readable width"
```

---

### Task 3: Apply the Selected Font to Code and Math Editing Surfaces

**Files:**
- Modify: `apps/desktop/src/styles.css:105-115, 200-215, 245-258, 285-335, 1575-1588`
- Test: `apps/desktop/test/blockWidgetLayout.test.ts`
- Test: `apps/desktop/test/Editor.test.ts`

**Interfaces:**
- Consumes: existing root variable `--omd-font-family` written by `App.tsx`.
- Produces: code and math editing selectors whose family is `var(--omd-font-family, ui-monospace, monospace)`.
- Preserves: all existing sizes, line heights, backgrounds, Shiki token color/style/weight, and export styles.

- [ ] **Step 1: Write failing CSS contract tests**

Add a helper assertion to `blockWidgetLayout.test.ts`:

```ts
function expectSelectedFont(selector: string) {
  expect(declarationBlocks(selector).join("\n")).toMatch(
    /font-family\s*:\s*var\(--omd-font-family,\s*ui-monospace,\s*monospace\)\s*;/,
  )
}
```

Add a test covering rendered code and math:

```ts
it("uses the selected editor font in rendered code and the math popup", () => {
  expectSelectedFont(".editor-host .omd-code pre")
  expectSelectedFont(".editor-host .omd-code pre code")
  expectSelectedFont(".editor-host .omd-math-editor")
})
```

Add an `Editor.test.ts` CSS-source assertion for inline and line-styled code:

```ts
it("uses the selected editor font for inline and source-style code", () => {
  const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  for (const selector of [".omd-inline-code", ".omd-codeblock"]) {
    const escaped = selector.replace(".", "\\.")
    expect(styles).toMatch(new RegExp(
      `${escaped}[^}]*font-family\\s*:\\s*var\\(--omd-font-family,\\s*ui-monospace,\\s*monospace\\)`,
    ))
  }
})
```

- [ ] **Step 2: Run the focused tests and verify hard-coded/UA fonts fail them**

Run:

```sh
pnpm --filter @omd/desktop exec vitest run test/blockWidgetLayout.test.ts test/Editor.test.ts
```

Expected: FAIL because inline/source code use fixed `ui-monospace`, the math editor uses a fixed family, and rendered Shiki code does not explicitly consume the selected family.

- [ ] **Step 3: Replace code-family overrides with the existing setting variable**

Use this exact declaration wherever the task covers a code/math editing family:

```css
font-family: var(--omd-font-family, ui-monospace, monospace);
```

Apply it to:

- `.editor-host .omd-inline-code`
- `.editor-host .omd-codeblock`
- `.editor-host .omd-code pre`
- `.editor-host .omd-code pre code`
- `.editor-host .omd-math-editor`

For `.omd-front-matter-src`, `.omd-block-error`, `.omd-block-placeholder`, and table-cell `code` declarations that currently use a fixed family or `font:` shorthand, preserve their current size and line height while changing only the family to the same variable. If a shorthand cannot contain the required fallback cleanly, split it into `font-size`, `line-height`, and `font-family` declarations.

Do not modify `packages/engine/src/export/styles.ts` or Shiki generation/cache code.

- [ ] **Step 4: Run focused tests**

Run:

```sh
pnpm --filter @omd/desktop exec vitest run test/blockWidgetLayout.test.ts \
  test/Editor.test.ts test/App.settingsAndSession.test.tsx
```

Expected: all pass, including the existing test that `App.tsx` writes `--omd-font-family`.

- [ ] **Step 5: Run the complete desktop test/build gate**

Run:

```sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: zero test failures and successful Vite/TypeScript build.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/styles.css apps/desktop/test/blockWidgetLayout.test.ts \
  apps/desktop/test/Editor.test.ts
git commit -m "fix: apply selected font to code surfaces"
```

---

### Task 4: Update Manual QA and Run the Cross-Domain Verification Gate

**Files:**
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Consumes: the completed interaction/layout behavior from Tasks 1-3.
- Produces: release/manual checks for the browser-dependent behavior that happy-dom cannot prove.

- [ ] **Step 1: Update the existing math popup QA item**

Extend the current math popup checklist item to require:

```text
click near the start/middle/end of multiline TeX and type to verify insertion at the clicked caret; drag-select with the mouse and replace the selection
```

- [ ] **Step 2: Add layout and font QA items near the existing rendering/settings checks**

Add checks that state:

```text
At document end, the final line can scroll to approximately mid-viewport and remains clickable/editable; no source lines or blank Markdown are inserted.
```

```text
In a wide window the centered readable column reaches 900px; narrow windows do not gain horizontal page overflow.
```

```text
After selecting JetBrains Mono or another visibly distinct installed font, prose, inline code, source-style code lines, rendered Shiki blocks, and the math popup textarea all use that family.
```

- [ ] **Step 3: Run repository checks matching all changed domains**

Run:

```sh
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

Expected: all commands exit 0. Do not claim lint or formatting checks; the repository has no repository-wide lint/format command.

- [ ] **Step 4: Inspect the final diff for scope**

Run:

```sh
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the approved spec/plan, engine event fix/tests, desktop theme/CSS/tests, and manual QA changes appear.

- [ ] **Step 5: Commit documentation**

```sh
git add docs/manual-qa.md
git commit -m "docs: add editor interaction reliability QA"
```
