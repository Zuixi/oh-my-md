# Structural List Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace regex/fixed-width list continuation and indentation with deterministic Lezer-structural behavior.

**Architecture:** Keep commands as pure transaction builders in the engine. Reuse `blockPrefixOf` for ordered quote/list/task segments and query `ListItem` ancestry for parent/sibling content columns. Emit list depth as a CSS custom property instead of clamping to four classes.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, Vitest, desktop CSS.

**Spec:** `docs/superpowers/specs/2026-10-28-structural-editing-alignment-design.md`

## Global Constraints

- Engine owns list syntax; desktop only styles emitted attributes/classes.
- No line regex as the source of list structure.
- No fixed two-space assumption for parent content columns.
- Unknown/incomplete tree returns `null`; never guess.
- Preserve ordered normalization reversibility.
- Multi-line selections and multi-cursor indentation are out of scope.

---

### Task 1: Structural list context and Enter

**Files:**
- Modify: `packages/engine/src/format/blockPrefix.ts`
- Modify: `packages/engine/src/format/lists.ts`
- Modify: `packages/engine/src/format/quotes.ts`
- Test: `packages/engine/test/list-continue.test.ts`
- Test: `packages/engine/test/enter-ownership.test.ts`

**Interfaces:**
- Produces an engine-internal structural query returning the current line,
  `BlockPrefix`, innermost `ListItem`, parent list item if nested, and the source
  content columns needed to step out one level.
- Keeps `continueListSpec(state): TransactionSpec | null`.

- [x] **Step 1: Add failing pure tests**

Cover literal source/selection results for:

- unordered, ordered, and task continuation;
- `> - item`, `- > item`, and nested quote/list combinations;
- `10. item` continuation without a fixed-width assumption;
- empty nested item stepping out one level;
- a second Enter on the resulting empty top-level item exiting the list;
- empty top-level quoted item preserving only the quote prefix;
- non-empty selections returning `null`;
- unavailable syntax-tree ancestry returning `null`.

- [x] **Step 2: Add a failing real-keymap ownership test**

Choose an empty nested-list case where upstream Markdown Enter and the desired
engine behavior differ. Register host keymaps before `editorExtensions()` and
assert the one-level step-out result.

- [x] **Step 3: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts test/enter-ownership.test.ts
```

- [x] **Step 4: Replace regex ownership**

Remove `LINE` and derive marker segments from `blockPrefixOf`. Use Lezer
`ListItem` ancestry to distinguish top-level from nested empty items. Build the
next marker from the innermost list segment, incrementing ordered markers and
resetting task markers. Mixed quote/list ownership comes from
`blockPrefix.ts::enterOwnerMark` (innermost non-task mark): `continueQuote`
returns `null` when a list owns the line, so `continueList` steps the list out
one level and keeps the quote.

Promote `listKeymap` to `Prec.highest`.

- [x] **Step 5: Run focused tests**

```bash
pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts test/enter-ownership.test.ts
```

### Task 2: Structural Tab and Shift-Tab

**Files:**
- Modify: `packages/engine/src/format/lists.ts`
- Modify: `packages/engine/src/format/blockPrefix.ts`
- Test: `packages/engine/test/list-continue.test.ts`

- [x] **Step 1: Add failing tests**

Cover:

- Tab under a previous unordered sibling;
- Tab under `10. parent` using its real content column;
- Tab inside a quote inserting indentation after the quote prefix;
- Tab with no previous sibling returning `null`;
- Shift-Tab removing exactly one list nesting level;
- Shift-Tab preserving enclosing quote and task marker text.

- [x] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts
```

- [x] **Step 3: Implement from Lezer positions**

Use the previous sibling `ListItem` marker/content start to compute the exact
indent insertion. Use parent `ListItem` ancestry to compute one-level outdent.
Do not insert/remove a fixed number of spaces. Widths are CommonMark visual
columns: 4-column tab stops, marker padding of 1–4 columns, one-column fallback
at 0 or 5+ (`blockPrefix.ts::visualColumn` / `listContentColumn`).

- [x] **Step 4: Run focused and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts test/ordered-renumber.test.ts
pnpm test
```

### Task 3: Unbounded visual list depth

**Files:**
- Modify: `packages/engine/src/decorations/blocks.ts`
- Modify: `packages/engine/src/decorations/blockWidget.ts`
- Modify: `apps/desktop/src/styles.css`
- Test: `packages/engine/test/blocks.test.ts`
- Test: `packages/engine/test/tableUpdateDOM.test.ts`
- Test: `apps/desktop/test/Editor.test.ts`
- Test: `apps/desktop/test/listDepthStyles.test.ts`
- Test: `apps/desktop/e2e/list-depth.spec.ts`

- [x] **Step 1: Add failing depth tests**

Build a valid five-level list and assert the fifth level emits depth `5`, not
the old `omd-li-4` clamp. Cover quote-inside-list depth as well.

- [x] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/blocks.test.ts
pnpm --filter @omd/desktop exec vitest run test/Editor.test.ts
```

- [x] **Step 3: Emit and consume a CSS variable**

Emit a stable base class plus:

```css
--omd-list-depth: <positive integer>
```

Derive list padding and quote-bar position with:

```css
calc(var(--omd-list-depth) * 1.2em)
```

Keep block widgets' hanging-indent override. The widget-level `padding`
shorthands (`.omd-block` / `.omd-math` / `.omd-table` / `.omd-code`) are declared
later at the same specificity and silently zero the left side, so the offset is
re-declared after them with higher specificity and applied exactly once: the code
wrapper owns it (its header must not add a second), while the editing chrome — a
direct child of `.cm-content`, no wrapper — carries it itself. Every widget
`updateDOM` path re-syncs the embed through `applyBlockEmbed`, which clears stale
classes and the property before writing.

- [x] **Step 4: Run cross-layer validation**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

### Task 4: Documentation and interaction QA

**Files:**
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/memory/known-gotchas.md`

- [x] **Step 1: Record structural ownership**

Document deterministic `Prec.highest` list ownership, parser-derived content
columns, nested empty-item step-out, and dynamic visual depth.

- [x] **Step 2: Add manual cases**

Include deep unordered/ordered/task lists, multi-digit ordered parents, quote
combinations, repeated Tab/Shift-Tab, and two-stage empty-item exit.

- [x] **Step 3: Run final diff validation**

```bash
git diff --check
```
