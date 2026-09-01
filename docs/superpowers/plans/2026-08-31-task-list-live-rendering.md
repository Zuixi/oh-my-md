# Task List Live Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide/fold the redundant leading list mark (`-`, `*`, `+`) before task list checkboxes in Live Preview mode to match Typora-like rendering.

**Architecture:** In `packages/engine/src/decorations/blocks.ts`, decorate `ListMark` nodes inside task items with an empty replace decoration (`Decoration.replace({})`), removing the visible `-` while keeping `TaskMarker` replaced with the interactive `CheckboxWidget`.

**Tech Stack:** TypeScript, CodeMirror 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-task-list-live-rendering-design.md`

## Global Constraints
- Engine remains framework-independent (no React/Tauri imports).
- Preserve source text fidelity (no silent rewrites of Markdown on render).
- No overlapping replace decorations in live preview.
- All tests in `packages/engine` and `apps/desktop` must pass.

---

### Task 1: Fold ListMark in Task List Items and Add Unit Tests

**Files:**
- Modify: `packages/engine/src/decorations/blocks.ts:215-245`
- Test: `packages/engine/test/blocks.test.ts`

**Interfaces:**
- Consumes: Lezer `SyntaxNodeRef`, CodeMirror `Decoration.replace({})`
- Produces: `replace:ListMark` decoration covering `node.from..node.to` for task list items

- [ ] **Step 1: Write the failing tests in `packages/engine/test/blocks.test.ts`**

```ts
it("folds list mark before task markers", () => {
  const doc = "- [x] done\n- [ ] todo"
  const state = makeState(doc)
  const specs = collectDecorationSpecs(state, 0, doc.length)
  const replaceMarks = specs.filter(s => s.tag === "replace:ListMark")
  const checkboxes = specs.filter(s => s.tag === "widget:checkbox")
  expect(replaceMarks).toHaveLength(2)
  expect(checkboxes).toHaveLength(2)
  assertNoReplaceOverlap(replaceRanges(doc, 0))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omd/engine test test/blocks.test.ts`
Expected: FAIL (found 0 `replace:ListMark` instead of 2).

- [ ] **Step 3: Implement minimal fix in `packages/engine/src/decorations/blocks.ts`**

In `styleListMark`:
```ts
if (node.node.parent?.getChild("Task")) {
  out.push({
    from: node.from,
    to: node.to,
    tag: "replace:ListMark",
    deco: Decoration.replace({}),
  })
  return
}
```

- [ ] **Step 4: Run engine and desktop tests**

Run:
```sh
pnpm test
pnpm --filter @omd/desktop test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/engine/src/decorations/blocks.ts packages/engine/test/blocks.test.ts docs/superpowers/specs/2026-08-31-task-list-live-rendering-design.md docs/superpowers/plans/2026-08-31-task-list-live-rendering.md
git commit -m "feat(engine): fold list mark in task list items"
```
