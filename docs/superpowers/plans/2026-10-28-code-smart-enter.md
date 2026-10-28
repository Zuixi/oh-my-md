# Code Smart Enter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align an auto-paired closing brace with its opening brace when Enter is pressed between `{}` inside fenced code.

**Architecture:** Extend the existing pure `continueCodeLineSpec`; do not add a second input handler or persistent state. Detect only adjacent `{|}` in fenced-code content and insert two prefixed lines with an explicit inner-line selection.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-structural-editing-alignment-design.md`

## Global Constraints

- Keep `codeLineKeymap` at `Prec.highest`.
- Preserve terminal-blank code-block exit and all non-paired Enter behavior.
- Do not enable stock `closeBrackets` or `indentOnInput`.
- Do not add dependencies or persistent state.

---

### Task 1: Paired-brace Enter transaction

**Files:**
- Modify: `packages/engine/src/format/codeLines.ts`
- Test: `packages/engine/test/enter-ownership.test.ts`

**Interfaces:**
- Consumes: `continueCodeLineSpec(state): TransactionSpec | null`
- Produces: the same signature with an adjacent `{|}` branch

- [ ] **Step 1: Write failing real-keymap tests**

Add literal expectations for:

```ts
"```cpp\n{}\n```"       -> "```cpp\n{\n  \n}\n```"
"```cpp\n  {}\n```"     -> "```cpp\n  {\n    \n  }\n```"
"> ```cpp\n> {}\n> ```" -> "> ```cpp\n> {\n>   \n> }\n> ```"
```

Place the caret between `{` and `}`, press Enter through the real assembled
keymap, and assert the caret is on the indented inner line.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/enter-ownership.test.ts -t "paired closing brace"
```

Expected: the existing `}` remains on the indented inner line.

- [ ] **Step 3: Implement the minimal branch**

In `continueCodeLineSpec`, after terminal-blank exit and before ordinary
continuation:

1. Compute the content-relative caret.
2. Require the previous content character to be `{` and the next to be `}`.
3. Compute the current leading content whitespace as `base`.
4. Insert:

```ts
`\n${info.prefix}${base}${INDENT_UNIT}\n${info.prefix}${base}`
```

5. Put the selection after the first newline, prefix, base, and indent unit.

Do not replace or duplicate the existing `}`.

- [ ] **Step 4: Run focused and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/enter-ownership.test.ts
pnpm test
```

### Task 2: Browser integration contract

**Files:**
- Modify: `apps/desktop/e2e/auto-pair.spec.ts`
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/memory/known-gotchas.md`

- [ ] **Step 1: Add a Playwright sequence**

Open an empty fenced C/C++ block, type `{`, press Enter, and assert the exact
document contains an indented blank line and an aligned existing `}`.

- [ ] **Step 2: Run the focused E2E**

```bash
pnpm --filter @omd/desktop test:e2e e2e/auto-pair.spec.ts
```

- [ ] **Step 3: Document the ownership rule and run diff validation**

```bash
git diff --check
```
