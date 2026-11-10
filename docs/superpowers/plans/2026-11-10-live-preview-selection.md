# Live Preview Selection Implementation Plan

> **For agentic workers:** Execute tasks in order with pi; the supervising agent reviews the diff and runs acceptance checks after each task, and advances only after acceptance. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make live-preview text selection visible and ensure that every selection copies the corresponding Markdown source.

**Architecture:** Keep `EditorState.selection` as the only clipboard range. Covered block widgets draw a readable selection layer. Code and table pointer gestures enter source-backed selection when dragged, while single clicks retain the existing editing controls.

**Tech Stack:** CodeMirror 6, React/Tauri desktop host, Vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-11-10-live-preview-selection-design.md`

## Global Constraints

- Preserve source bytes and existing Markdown copy behavior; no extra dependencies.
- Keep all code comments in English, including changes to existing comments.
- Preserve block-widget lifecycle, selection navigation, table direct edit, and large-document windowing.
- Keep new source files within the module-size gate; legacy oversized files may only shrink.
- Each pi task touches only its declared files and never commits or pushes.
- Supervisor reviews each task, runs its acceptance command and relevant browser behavior, then approves before the next task.

---

### Task 1: Readable covered blocks

**Files:**
- Modify: `apps/desktop/src/styles.css:319`
- Create: `apps/desktop/e2e/selection-markdown.spec.ts`

**Interfaces:** Existing `omd-block-covered` from `blockSelectionOverlay.ts`; no engine interface change.

- [ ] **Step 1: Add a browser regression** that selects an entire document containing a highlighted fenced code block, GFM table, list, and quote; compare text readability in both themes, verify the selection covers the block and the document bytes remain unchanged. Include a drag-driven case as well as programmatic select-all.
- [ ] **Step 2: Run the targeted spec** with `PW_PORT=9437 pnpm --filter @omd/desktop exec playwright test e2e/selection-markdown.spec.ts`; record the initial failure.
- [ ] **Step 3: Fix the covered-widget paint order** so the selection appears behind code/table glyphs and above or visibly through their backgrounds. Preserve focus, mouse events, widget controls, and theme colors.
- [ ] **Step 4: Run the same spec** and inspect a real-browser screenshot in both themes; require readable body text and no unrelated visual regression.
- [ ] **Step 5: Supervisor reviews**, re-runs acceptance, checks `git diff --check`, and either accepts or gives pi concrete corrections.

### Task 2: Code-body pointer selection and Markdown copy

**Files:**
- Modify: `packages/engine/src/decorations/widgets/code.ts`
- Modify: `packages/engine/src/decorations/blocks.ts` only if selection-driven source visibility requires it
- Extend: `apps/desktop/e2e/selection-markdown.spec.ts`
- Add a focused engine test in `packages/engine/test/codeChrome.test.ts` if a pure offset mapper is introduced.

**Interfaces:** Existing `blockWidgetRange`, `blockPrefixOf`, `CodeWidget` click controls, and CodeMirror selection. No host clipboard override.

- [ ] **Step 1: Add failing real-browser gestures** for forward/reverse partial code selection, multiline code, quoted fences, drag from and into neighbouring paragraphs, placeholder/Shiki states, clipboard exact bytes, and click-to-edit.
- [ ] **Step 2: Run the targeted browser spec** on a free port and confirm the expected clipboard/selection failures.
- [ ] **Step 3: Implement the smallest source-backed pointer path**: map the hit line and character to source offsets, keep drag continuity across widget boundaries, and use CodeMirror selection for copy. Preserve Shiki and the existing click/edit controls; test source-offset mapping of quote prefixes and whitespace.
- [ ] **Step 4: Run targeted browser and engine tests**; review DOM selection versus `EditorState.selection`, focus, re-render stability, and unchanged document bytes.
- [ ] **Step 5: Supervisor reviews** every changed file and tests. Correct failed edge cases before Task 3.

### Task 3: Table click-versus-drag selection

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/src/decorations/widgets/tableCellEdit.ts` only if needed for pointer ownership
- Extend: `apps/desktop/e2e/selection-markdown.spec.ts`
- Add a focused engine test under `packages/engine/test/` for any pure cell-offset mapper.

**Interfaces:** Existing `TableData`/`TableCellData` source ranges, `tableAt`, direct-edit session, source reveal, `blockWidgetRange`. Existing toolbar and input still handle clicks.

- [ ] **Step 1: Add failing browser gestures** for in-cell, cross-cell, cross-block and reverse drags; test escaped pipes, inline markup, missing cells, and noncanonical tables. Assert clipboard equals the document's exact selected substring.
- [ ] **Step 2: Run the targeted browser spec** to reproduce pointer interception and wrong or absent selection.
- [ ] **Step 3: Preserve direct edit on press and promote only a drag** to a source-backed range via existing table source offsets; keep keyboard and toolbar behavior intact.
- [ ] **Step 4: Run browser and table engine tests** and inspect click, keyboard, IME, read-only, and selection copy behavior.
- [ ] **Step 5: Supervisor reviews** changed modules and rejects any hidden fallbacks or non-source clipboard paths.

### Task 4: Integration and delivery

**Files:**
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/known-gotchas.md` plus the relevant gotcha file only if a reusable new trap was verified.
- Revisit affected `AGENTS.md` only if an invariant or module route changed.

- [ ] **Step 1: Add manual checks** for covered and partial drag selections, copied Markdown bytes, click-to-edit, read-only, and light/dark themes.
- [ ] **Step 2: Supervisor checks** `pnpm check:quality`, `pnpm test`, `pnpm --filter @omd/desktop test`, `pnpm --filter @omd/desktop build`, and the relevant Playwright suite. Run `pnpm verify` if cross-domain link/release gates are needed.
- [ ] **Step 3: Review the complete diff**, test cases, module size, performance-sensitive paths, and changed comments; resolve every finding.
- [ ] **Step 4: Commit with short conventional subjects**, push the branch, open a PR with `gh`, wait for required CI checks, review their logs, and merge into `main` after all pass.

## Self-review

- The design's three reproduced failures map to Tasks 1–3.
- Task 4 checks clipboard semantics across all changed domains and records user-facing QA.
- No Rust IPC or dependency changes are expected; revise this plan if implementation discovers that boundary.
