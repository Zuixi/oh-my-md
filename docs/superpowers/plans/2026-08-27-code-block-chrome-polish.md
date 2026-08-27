# Code Block Chrome Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans + TDD per `@omd/engine` AGENTS.md.

**Goal:** Fix P0 gaps vs Typora figure 2: compact line-number gutter, tighter line height, custom language picker that opens downward (search + checkmark).

**Architecture:** Extract `codeLangPicker.ts` (vanilla DOM, FontFamilyPicker idiom); wire from `CodeWidget.buildHeader`; tighten `.omd-code*` CSS in desktop `styles.css`.

**Tech stack:** `@omd/engine`, Vitest/happy-dom, desktop CSS

---

### Task 1: Language picker (TDD)

**Files:**
- Create: `packages/engine/src/decorations/widgets/codeLangPicker.ts`
- Create: `packages/engine/test/codeLangPicker.test.ts`

**Steps:** Test trigger label, downward popover, search filter, select + close, outside dismiss, disabled.

---

### Task 2: Wire picker + header tools

**Files:**
- Modify: `packages/engine/src/decorations/widgets/code.ts`

Replace native `<select>`; group lang + Copy in `.omd-code-tools`; Copy label text.

---

### Task 3: Compact gutter CSS

**Files:**
- Modify: `apps/desktop/src/styles.css`

Remove double `padding-left` on `pre` + `.line`; line-height ~1.45; lang picker + tools pill styles.

---

### Task 4: Verify + docs

**Steps:** `pnpm test`; update `docs/manual-qa.md` checklist for gutter/dropdown.
