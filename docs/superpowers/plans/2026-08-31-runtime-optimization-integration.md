# Runtime Optimization Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish shared baselines, integrate the Desktop, Engine, and Rust optimization workstreams, and record verified before/after evidence.

**Architecture:** This plan owns no primary optimization implementation. It runs before the subsystem plans to capture baselines, then resumes after their commits to perform cross-layer review, full verification, documentation updates, and measurable acceptance.

**Tech Stack:** pnpm workspaces, Vitest benchmark, Vite, Cargo, Git.

**Spec:** `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`

## Global Constraints

- Execute baseline Task 1 before starting subsystem implementation.
- Desktop, Engine, and Rust plans may proceed in parallel after the baseline.
- Do not merge optional build-driver or quick-open changes without their benchmark gate.
- Preserve unrelated working-tree changes and untracked table-editing documents.
- `pnpm verify` does not lint or format; do not claim repository-wide lint passed.
- Record exact commands and observed numbers in the spec implementation appendix.

## Related Plans

- `docs/superpowers/plans/2026-08-31-desktop-editor-status-and-app-boundaries.md`
- `docs/superpowers/plans/2026-08-31-engine-highlight-cache-and-lazy-loading.md`
- `docs/superpowers/plans/2026-08-31-rust-workspace-search-parallelism.md`

---

### Task 1: Capture the pre-change baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`

**Interfaces:**
- Produces an `Implementation Evidence` appendix with a `Before` table.

- [ ] **Step 1: Confirm a clean optimization baseline**

Run:

```sh
git status --short
git --no-pager log -1 --oneline
```

Expected: only known unrelated working-tree files are present. Record the base
commit hash.

- [ ] **Step 2: Capture desktop bundle output**

Run:

```sh
pnpm --filter @omd/desktop build 2>&1 | tee /tmp/omd-desktop-build-before.log
```

Record:

- main `index-*.js` raw and gzip size;
- largest lazy chunks;
- build duration;
- chunk warnings.

Expected baseline main chunk: approximately 1,226.70 kB raw / 410.07 kB gzip.

- [ ] **Step 3: Capture engine benchmarks**

Run:

```sh
pnpm --filter @omd/engine bench 2>&1 | tee /tmp/omd-engine-bench-before.log
```

Record all reported typing p95, open-ingest, toggle, decoration, and stats
numbers plus any budget warnings.

- [ ] **Step 4: Capture Rust search timing**

Before the Rust plan adds the ignored benchmark, run the existing 600-file cap
test as a behavioral baseline:

```sh
time cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  search_caps_results_and_marks_truncated -- --nocapture
```

Record that this includes compilation/test-harness overhead and is not directly
comparable to the later ignored fixture benchmark.

- [ ] **Step 5: Append the exact baseline table**

Add an `Implementation Evidence` appendix with a `Before` table containing the
concrete base commit, main raw/gzip chunk sizes, engine budget-warning count,
and the Rust `500 hits, truncated=true` result. Generate the baseline line with:

```sh
BASELINE_COMMIT=$(git rev-parse HEAD)
printf 'Baseline commit: `%s`\n' "$BASELINE_COMMIT"
```

Paste the printed 40-character hash into the appendix as a standalone
`Baseline commit:` line. Do not save the appendix while any cell contains a
placeholder or approximation.

- [ ] **Step 6: Commit the baseline**

```sh
git add docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md
git commit -m "docs: record optimization baseline"
```

### Task 2: Review subsystem commits before integration

**Files:**
- Review only; no required edit.

**Interfaces:**
- Consumes the final commits from all three subsystem plans.

- [ ] **Step 1: Verify workstream file ownership**

Run:

```sh
BASELINE_COMMIT=$(sed -n 's/^Baseline commit: `\([0-9a-f]\{40\}\)`$/\1/p' \
  docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md)
test -n "$BASELINE_COMMIT"
git --no-pager diff --name-status "$BASELINE_COMMIT"..HEAD
```

Expected:

- Desktop work primarily touches `apps/desktop/src`, desktop tests, and desktop
  `AGENTS.md`;
- Engine work primarily touches `packages/engine`;
- Rust work primarily touches `apps/desktop/src-tauri/src/workspace.rs`;
- no subsystem edited the unrelated table-editing spec/plan.

- [ ] **Step 2: Review Desktop invariants**

Confirm:

- no dummy App state exists solely for edit-triggered rerenders;
- selection and mode status reach only the status subscriber;
- stale identities are checked before publishing;
- document payloads still omit full text;
- materialization and recovery remain trailing and flushable;
- process-global safe-mode flags follow only the active tab.

- [ ] **Step 3: Review Engine invariants**

Confirm:

- cache is bounded by 128 entries and 8 MiB estimated UTF-16 storage;
- oversize entries are not retained;
- no runtime static import of `shiki/core` or `shiki/engine/javascript` remains
  in the live code-widget entry path;
- async fallback and stale-widget guards remain;
- optional build-driver edits have benchmark evidence and equivalence tests.

- [ ] **Step 4: Review Rust invariants**

Confirm:

- line iteration occurs before the result mutex lock;
- atomic reservation cannot exceed 500;
- lock poisoning returns `Err`;
- final sort and truncate remain;
- existing IPC types and command signatures are unchanged.

### Task 3: Run targeted integration verification

**Files:**
- Modify only if a tightly coupled regression is found.

- [ ] **Step 1: Run Engine tests**

Run:

```sh
pnpm test
```

Expected: TypeScript check and all engine tests PASS.

- [ ] **Step 2: Run Desktop tests**

Run:

```sh
pnpm --filter @omd/desktop test
```

Expected: all desktop tests PASS, including render-boundary, materialization,
search, scale, save, normalization, and large-document tests.

- [ ] **Step 3: Run Rust formatting and tests**

Run:

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 4: Run advisory benchmarks**

Run:

```sh
pnpm --filter @omd/engine bench
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  workspace_search_parallelism_benchmark -- --ignored --nocapture
```

Expected:

- no new engine budget warning;
- Rust benchmark prints elapsed time and preserves 500-hit truncation.

- [ ] **Step 5: Build the desktop bundle**

Run:

```sh
pnpm --filter @omd/desktop build
```

Expected:

- build PASS;
- main chunk no longer owns eager live-code Shiki initialization;
- target main raw size is at least 10% below 1,226.70 kB.

If the 10% target is missed, inspect the generated chunk graph and document
the reason. Do not mark the optimization complete based only on dynamic-import
source text.

### Task 4: Run full repository verification

**Files:**
- Modify only for regressions caused by this optimization series.

- [ ] **Step 1: Run the standalone full gate**

Run:

```sh
pnpm verify
```

Expected: `scripts/test.sh` and `scripts/build.sh` PASS, including Rust app
linking.

- [ ] **Step 2: Check the final worktree**

Run:

```sh
git status --short
BASELINE_COMMIT=$(sed -n 's/^Baseline commit: `\([0-9a-f]\{40\}\)`$/\1/p' \
  docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md)
test -n "$BASELINE_COMMIT"
git --no-pager diff --check "$BASELINE_COMMIT"..HEAD
```

Expected: no generated `dist` output or temporary benchmark files are staged;
known unrelated untracked table-editing docs remain untouched.

### Task 5: Record after evidence and documentation decisions

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`
- Review and modify only if required:
  - `apps/desktop/AGENTS.md`
  - `packages/engine/AGENTS.md`
  - `docs/memory/known-gotchas.md`
  - `docs/manual-qa.md`

**Interfaces:**
- Produces a final `After` evidence table and deviation record.

- [ ] **Step 1: Append exact after measurements**

Add an `After` table containing concrete values for:

- main raw and gzip JavaScript size;
- App-shell commits during the pre-materialization edit burst;
- observed latest StatusBar cursor/mode;
- cache limits (`128 entries / 8 MiB`);
- engine budget-warning count;
- the printed Rust 1,000×200 advisory milliseconds.

The table must compare the raw main chunk against 1,226.70 kB and state whether
the 10% target passed. Do not commit while any result is missing or described
only as “pass”; include the observed number or exact test assertion.

- [ ] **Step 2: Record optional-work decisions**

State explicitly:

- whether build-driver production code changed and the benchmark reason;
- whether quick-open batching changed and the measurement reason;
- whether the main-bundle 10% target was met;
- any implementation deviation from the approved spec.

- [ ] **Step 3: Check documentation maintenance**

Update:

- Desktop `AGENTS.md` if the editor-status boundary landed;
- Engine `AGENTS.md` if bounded cache/lazy loader invariants landed;
- `known-gotchas.md` only for a newly verified recurring trap;
- `manual-qa.md` only if visible status timing or behavior changed.

Do not update README or changelog for unchanged user-visible behavior.

- [ ] **Step 4: Commit evidence and documentation**

```sh
git add docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md \
  apps/desktop/AGENTS.md packages/engine/AGENTS.md \
  docs/memory/known-gotchas.md docs/manual-qa.md
git commit -m "docs: record optimization results"
```

Stage only files that actually changed.

### Task 6: Final review checkpoint

**Files:**
- Review only.

- [ ] **Step 1: Review commit boundaries**

Run:

```sh
BASELINE_COMMIT=$(sed -n 's/^Baseline commit: `\([0-9a-f]\{40\}\)`$/\1/p' \
  docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md)
test -n "$BASELINE_COMMIT"
git --no-pager log --oneline "$BASELINE_COMMIT"..HEAD
```

Expected: small commits corresponding to cache, loader, status boundary,
materialization, search parallelism, optional benchmark-gated work, and final
evidence.

- [ ] **Step 2: Confirm acceptance checklist**

Confirm all statements with command or test evidence:

- App does not rerender once per document-changing transaction;
- StatusBar remains current for cursor and mode;
- cache memory is bounded;
- Shiki live highlighter is lazy;
- Rust search does not hold the result mutex during line scanning;
- all behavior suites pass;
- full linked build passes;
- optional changes were admitted only through their gates.

- [ ] **Step 3: Prepare branch handoff**

Use `superpowers:finishing-a-development-branch` to choose merge, PR, or branch
cleanup only after every acceptance item above is checked.
