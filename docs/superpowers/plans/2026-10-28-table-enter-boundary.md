# Table Enter Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop repeated Enter from appending unlimited table rows while preserving Tab as the explicit row-extension gesture.

**Architecture:** Change only the final-row branch of `tableNextRowSpec` to use the existing idempotent `exitTableSpec`. Keep source-grid editing, Lezer navigation, validated range edits, toolbar behavior, and final-cell Tab append unchanged.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-structural-editing-alignment-design.md`

## Global Constraints

- Plain Enter must never insert a raw newline into table source.
- Final-cell Tab must still append one row.
- Mod-Enter and existing blank-line reuse remain unchanged.
- No table widget or parser refactor.

---

### Task 1: Final-row Enter exits

**Files:**
- Modify: `packages/engine/src/format/tableKeymap.ts`
- Test: `packages/engine/test/tableKeymap.test.ts`
- Test: `packages/engine/test/tableKeymapWiring.test.ts`

- [ ] **Step 1: Replace append expectations with failing exit expectations**

Assert that Enter from either the last-row cell body or `Table.to`:

- does not append a source row;
- preserves the existing table bytes;
- places the caret on the blank paragraph after the table;
- creates the blank paragraph idempotently when the table ends the document.

Keep the final-cell Tab append assertion unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/tableKeymap.test.ts test/tableKeymapWiring.test.ts
```

Expected: current Enter appends a row.

- [ ] **Step 3: Implement the minimal branch**

Change:

```ts
return cellAt(state, pos) ? appendRowSpec(state, pos) : null
```

to reuse `exitTableSpec(state)` when a cell exists and no row exists below.

- [ ] **Step 4: Run focused and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/tableKeymap.test.ts test/tableKeymapWiring.test.ts
pnpm test
```

### Task 2: Browser and documentation contract

**Files:**
- Modify: `apps/desktop/e2e/table-navigation.spec.ts`
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/memory/known-gotchas.md`

- [ ] **Step 1: Update E2E**

Assert final-row Enter exits the table and a second Enter edits the outside
paragraph rather than adding a row. Retain final-cell Tab append coverage.

- [ ] **Step 2: Run focused E2E**

```bash
pnpm --filter @omd/desktop test:e2e e2e/table-navigation.spec.ts
```

- [ ] **Step 3: Run diff validation**

```bash
git diff --check
```

