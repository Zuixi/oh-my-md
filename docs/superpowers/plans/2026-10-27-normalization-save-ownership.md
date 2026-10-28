# Normalization Save Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused, unguarded duplicate normalization save implementation so `documentSaveRunner` remains the only document persistence owner.

**Architecture:** Production normalization acceptance already calls `createNormalizationHandlers(...).accept`, which delegates to `saveExplicit`, and `documentSaveRunner` captures/accepts normalization after a successful guarded `saveDocument`. Delete the obsolete `TabSaveHost`/`createTabSaver` path instead of maintaining two save state machines.

**Tech Stack:** TypeScript, React 19 host utilities, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- All Markdown document writes must use `saveDocument(path, contents, expected)`.
- Successful persistence alone may update baseline/version or accept pending normalization.
- Save cancellation, conflict, stale identity, and failure must keep normalization pending.
- Do not change `createNormalizationHandlers`, `prepareTabSave`, `completeAccept`, or `documentSaveRunner` behavior.

---

### Task 1: Add an enforceable save-ownership guard

**Files:**
- Create: `apps/desktop/test/normalizationSaveOwnership.test.ts`
- Read: `apps/desktop/src/normalizationCoordinator.ts`
- Read: `apps/desktop/src/documentSaveRunner.ts`

**Interfaces:**
- Consumes: repository source files.
- Produces: a test that prevents an unguarded normalization-specific saver from returning.

- [ ] **Step 1: Write the failing architecture test**

```ts
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const coordinator = readFileSync(
  new URL("../src/normalizationCoordinator.ts", import.meta.url),
  "utf8",
)
const runner = readFileSync(
  new URL("../src/documentSaveRunner.ts", import.meta.url),
  "utf8",
)

describe("normalization save ownership", () => {
  it("keeps document persistence in documentSaveRunner only", () => {
    expect(coordinator).not.toContain("export interface TabSaveHost")
    expect(coordinator).not.toContain("export function createTabSaver")
    expect(coordinator).not.toContain("host.writeFile(")
    expect(runner).toContain("host.saveDocument(targetPath, snapshot, expected)")
    expect(runner).toContain("completeAccept(")
  })
})
```

- [ ] **Step 2: Run the test and confirm the current duplicate fails it**

Run:

```bash
pnpm --filter @omd/desktop exec vitest run test/normalizationSaveOwnership.test.ts
```

Expected: FAIL because `normalizationCoordinator.ts` still exports `TabSaveHost` and `createTabSaver`.

- [ ] **Step 3: Commit the failing guard**

```bash
git add apps/desktop/test/normalizationSaveOwnership.test.ts
git commit -m "test: enforce guarded normalization save ownership"
```

### Task 2: Delete the obsolete save state machine

**Files:**
- Modify: `apps/desktop/src/normalizationCoordinator.ts:206-390`
- Test: `apps/desktop/test/normalizationSaveOwnership.test.ts`
- Test: `apps/desktop/test/normalizationCoordinator.test.ts`
- Test: `apps/desktop/test/documentSaveRunner.test.ts`

**Interfaces:**
- Preserves: `prepareTabSave`, `completeAccept`, `resyncTabNormalization`, `createNormalizationHandlers`, `createSkippedStatusNotifier`.
- Removes: `TabSaveHost`, `createSaveQueueRunner`, `SessionPersistenceHost`, `createSessionPersistence`, `createTabSaver`.

- [ ] **Step 1: Verify the obsolete exports have no consumers**

Run:

```bash
rg -n "createTabSaver|createSaveQueueRunner|createSessionPersistence|TabSaveHost" apps/desktop
```

Expected: matches only declarations in `normalizationCoordinator.ts` and the new ownership test.

- [ ] **Step 2: Remove the duplicate implementation**

Delete the unused interfaces/functions listed above. Remove imports that become unused, including persistence helpers used only by `createSessionPersistence` or `createTabSaver`.

Do not move the code into `documentSaveRunner`; it is already implemented there with:

```ts
const result = await host.saveDocument(targetPath, snapshot, expected)
if (result.status === "saved" && capture) {
  const done = completeAccept(
    capture, host.getWorkspace(), host.getViews(), host.getNormalization(),
  )
  host.setNormalization(done.nextState)
  if (done.transaction) view.dispatch(done.transaction)
}
```

- [ ] **Step 3: Run focused tests**

```bash
pnpm --filter @omd/desktop exec vitest run \
  test/normalizationSaveOwnership.test.ts \
  test/normalizationCoordinator.test.ts \
  test/documentSaveRunner.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run desktop validation**

```bash
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/normalizationCoordinator.ts \
  apps/desktop/test/normalizationSaveOwnership.test.ts
git commit -m "refactor: keep normalization persistence on guarded save path"
```

## Why This Plan, Not the Alternatives

- **Why delete instead of repair `createTabSaver`:** it has no production consumer. Repairing dead code creates a second state machine that can drift again.
- **Why use a source ownership test:** TypeScript cannot fail on an exported-but-unused function under the current engine/desktop compiler settings. The test enforces the architectural invariant directly.
- **Why not merge normalization into `documentSaveRunner`:** it is already integrated there through `prepareTabSave` and `completeAccept`; further merging would reduce cohesion.
