# Runtime and Maintainability Optimization Design

Date: 2026-08-31

Status: Approved for implementation planning

## 1. Context

The current implementation already has strong large-document foundations:

- partial Lezer parsing instead of production full-tree forcing;
- progressive and viewport-windowed live-preview decorations;
- render budgets for expensive block widgets;
- debounced document materialization, statistics, find, and outline work;
- streamed large-document open into CodeMirror `Text`;
- stat-first document version probing with guarded saves;
- lazy Mermaid, KaTeX, Turndown, theme, and language grammar loading.

The engine benchmark suite passes without budget warnings, including the
existing `<16ms` typing p95 budgets. The desktop production build succeeds, but
the main JavaScript chunk is currently 1,226.70 kB raw / 410.07 kB gzip.

The remaining high-value opportunities are concentrated in four areas:

1. `App.tsx` still commits the entire React shell for each document-changing
   transaction so that cursor and mode text can refresh.
2. code-block rendered HTML is retained in an unbounded process-lifetime map.
3. Shiki core and its JavaScript regex engine are statically included even
   before the first highlighted code block is rendered.
4. Rust workspace search holds a shared result mutex while scanning every line
   of a matched Markdown file, reducing the benefit of the parallel walker.

There are also maintainability risks in the 2,597-line `App.tsx`, which owns
many independent workflows through dozens of state and ref values. This design
addresses that complexity only where it supports the optimization work; it
does not authorize a general rewrite.

## 2. Goals

1. Remove full-App React commits from the per-keystroke document update path
   while preserving immediate cursor and editor-mode feedback.
2. Bound the memory retained by code-block syntax-highlight HTML.
3. Remove Shiki highlighter initialization code from the eager desktop bundle.
4. Restore meaningful parallelism to workspace Markdown search without changing
   its IPC contract or result semantics.
5. Extract the App-owned workflows touched by this work behind narrow,
   independently tested controller or hook interfaces.
6. Add reproducible evidence for each optimization so improvements are measured
   rather than inferred.
7. Preserve all existing large-document, guarded-save, normalization, recovery,
   search, and live-preview invariants.

## 3. Non-goals

- Replacing React state management with Redux, Zustand, or another framework.
- Rewriting CodeMirror, Lezer, or the progressive decoration architecture.
- Changing Markdown syntax or rendered output.
- Changing workspace-search IPC arguments, response fields, caps, sort order,
  hidden-file behavior, `.gitignore` behavior, or UTF-16 offsets.
- Optimizing snapshot rotation, settings reads, or other low-frequency native
  paths without new profiling evidence.
- Adding hard timing gates to CI that are sensitive to runner load.
- Splitting files solely to satisfy a line-count target.
- Implementing additional product features during the refactor.

## 4. Delivery Model

Implementation is organized as four workstreams.

### 4.1 Workstream A: Desktop React runtime and App boundaries

Owns:

- `apps/desktop/src/App.tsx`;
- a new desktop-owned editor-status store or hook;
- controllers or hooks extracted from App as part of the changed workflows;
- focused desktop tests.

It must not change Markdown semantics or native IPC.

### 4.2 Workstream B: Engine cache and loading behavior

Owns:

- `packages/engine/src/decorations/widgets/code.ts`;
- a small reusable bounded cache module if extraction improves testability;
- engine tests and benchmark scenarios;
- optional `buildDriver` or `TableWidget` changes only after their new
  benchmarks demonstrate a meaningful problem.

It must keep the engine React- and Tauri-independent.

### 4.3 Workstream C: Rust workspace search

Owns:

- `apps/desktop/src-tauri/src/workspace.rs`;
- native tests for search and quick-open behavior;
- an advisory local measurement fixture or command.

It must preserve the existing TypeScript/Rust wire contract.

### 4.4 Workstream D: Baselines and integration

Owns:

- recording before/after bundle and benchmark evidence;
- cross-workstream regression checks;
- directly related documentation updates;
- final `pnpm verify`.

Workstreams A, B, and C may be implemented in parallel after Workstream D
records the baseline. They modify separate primary directories. Workstream D
performs the final integration after all three complete.

## 5. Workstream A Design

### 5.1 Current update path

`handleDocumentUpdate` currently performs these responsibilities:

1. reject a stale editor binding;
2. queue changed documents for trailing materialization;
3. invalidate the active tab's outline cache version;
4. increment a React `docVersion` state value;
5. project ordered-list normalization state.

The fourth step commits the full App shell for every document-changing
transaction. The document itself is already materialized on the existing
trailing timer, so this commit exists primarily to refresh `editorStatus()` in
App render.

### 5.2 Editor-status boundary

Introduce a desktop-owned status source with a narrow contract:

```ts
export interface EditorStatusSnapshot {
  cursor: string
  mode: string
}

export interface EditorStatusStore {
  getSnapshot(): EditorStatusSnapshot
  subscribe(listener: () => void): () => void
  publish(snapshot: EditorStatusSnapshot): void
}
```

The exact module name may follow existing desktop naming, but the behavior is
fixed:

- App creates one stable store for the active editor surface.
- Editor update handling publishes status after relevant transactions.
- `StatusBar` subscribes through `useSyncExternalStore` or an equivalent
  narrowly scoped hook.
- Publishing an unchanged snapshot is a no-op.
- Switching tabs publishes the newly active view's snapshot.
- Destroyed, inactive, or stale editor bindings cannot publish active status.
- App no longer owns a dummy state value whose only purpose is to force a
  shell-wide render.

This source carries only small presentation data. It does not store document
text, save state, normalization state, or other application state.

### 5.3 Document data flow

CodeMirror remains the immediate document truth. Existing behavior remains:

```text
CodeMirror transaction
  ├─ status publish ───────────────► StatusBar-only React update
  ├─ pendingDocTabsRef add
  ├─ outline version invalidation
  ├─ normalization projection
  └─ trailing materialization
       ├─ docsRef update
       ├─ active React doc update
       └─ recovery write
```

The existing materialization interval is not changed by this design.

### 5.4 App workflow extraction

After the render boundary is proven, extract only cohesive workflows touched by
the optimization:

1. editor status and document materialization;
2. large-document render policy and per-tab scale metadata;
3. search/file-tree refresh orchestration;
4. open/restore lifecycle if required to make active-view status publication
   testable.

Guarded save and normalization already have dedicated modules and must be
extended rather than re-inlined. Each extracted unit must expose a narrow typed
interface and have tests that do not require rendering the full App unless the
integration itself is under test.

No file-size assertion is required. Success is measured by responsibility and
test boundaries, not by moving the same complexity into a differently named
large file.

### 5.5 Desktop failure behavior

- A missing editor view produces the existing neutral status rather than
  throwing.
- Stale tab/document/view identities are ignored, matching current update
  guards.
- Status publication must never delay or reject a CodeMirror transaction.
- Materialization, recovery, save, and normalization failures keep their
  current reporting paths and semantics.

## 6. Workstream B Design

### 6.1 Bounded highlighted-HTML cache

Replace the module-level unbounded map with an LRU cache bounded by both:

- maximum entry count: 128;
- approximate retained HTML size: 8 MiB, measured as JavaScript string UTF-16
  storage (`length * 2`) for deterministic accounting.

Rules:

- cache key remains the resolved language plus source text;
- a hit refreshes recency;
- insertion evicts least-recently-used entries until both limits are met;
- a single rendered result larger than the byte limit is returned to the
  caller but not cached;
- replacement adjusts retained-byte accounting correctly;
- cache storage remains internal to the engine and cannot alter rendered HTML;
- tests may use an explicit cache instance or test-only inspection API, but no
  cache-control API is exported from `packages/engine/src/index.ts`.

The limits must be named constants. They are engine-local and require no
cross-layer duplication.

### 6.2 Lazy Shiki core

`code.ts` must not statically import `shiki/core` or
`shiki/engine/javascript`. The first highlighted code block loads, in one
memoized promise:

- Shiki core;
- the JavaScript regex engine;
- light and dark themes.

Language grammars remain dynamically loaded by the existing loader map.

The exporter may retain its own dynamic chunk and highlighter lifetime. Sharing
the live widget highlighter with export is not required because the paths have
different timing and isolation requirements.

Failure behavior remains source-shaped:

- synchronous plain-code fallback is installed before async work;
- import, theme, language, or highlighting failure leaves the fallback intact;
- failures do not reject into CodeMirror lifecycle code;
- a failed initialization may be retried only if the current promise ownership
  can do so without concurrent duplicate loads. The implementation plan must
  choose and test one deterministic policy.

### 6.3 Table widget equality

Add a focused benchmark or allocation-sensitive unit scenario before changing
`TableWidget.eq`.

If `TableData` is proven to be a deterministic function of the already-compared
source and embed inputs, remove the `JSON.stringify` comparison. Otherwise,
compute a stable comparison token once when table data is built rather than
serializing both tables during every equality check.

No change is authorized without a test demonstrating equality for:

- identical source and table;
- changed cell source;
- changed alignment or structure;
- identical table source in distinct document positions;
- changed embed context.

### 6.4 Build-driver interval scans

Add an advisory benchmark with many disjoint pending ranges and visible regions.
Only optimize if the benchmark shows material time or allocation growth beyond
the existing normal viewport cases.

The preferred optimization, if justified, is:

- compute visible, build, and prune windows once per pass;
- exploit the existing sorted, disjoint ranges with a two-pointer intersection;
- avoid constructing a full clipped target list when the next nearest chunk can
  be selected directly;
- preserve closed-range and point-range semantics exactly.

This is deliberately benchmark-gated because current large-document benchmarks
pass and the common case has few visible regions.

## 7. Workstream C Design

### 7.1 Search collection

The parallel walker must not hold the shared results mutex while scanning file
lines.

Each worker callback:

1. validates the entry and reads the file as today;
2. scans the file into a worker-local or callback-local `Vec<SearchHit>`;
3. uses a shared atomic reservation/count mechanism to respect the global hit
   cap;
4. acquires the shared collection lock only to append a batch;
5. requests walker termination once the cap is exhausted.

The final collection is sorted by path and line, truncated to the existing cap,
and returned with the existing `truncated` semantics.

The implementation must avoid:

- returning more than `MAX_SEARCH_HITS`;
- claiming `truncated: false` when additional matching results were skipped;
- depending on thread completion order for final output;
- holding borrowed file content across lock acquisition unnecessarily;
- poisoning a mutex becoming a panic at the Tauri command boundary.

### 7.2 Quick-open collection

`list_markdown_files_sync` has shorter lock duration than search, but it still
locks once per path. The same workstream should evaluate batch collection per
worker. It should be changed only if the implementation remains simple and
preserves the 5,000-file cap and deterministic final sort.

### 7.3 Search errors

The existing best-effort traversal remains:

- unreadable entries and files are skipped;
- non-UTF-8 files are skipped;
- traversal setup and invalid query/root errors remain explicit;
- no new silent fallback returns success-shaped data after an internal
  synchronization failure.

## 8. Measurements and Acceptance Criteria

### 8.1 Baseline record

Before implementation, record:

- `pnpm --filter @omd/desktop build` chunk sizes;
- `pnpm --filter @omd/engine bench` output;
- App-shell and StatusBar commit counts for a deterministic burst of editor
  updates;
- workspace search timing over a generated, deterministic multi-file fixture.

The fixture must live in test-managed temporary storage and be cleaned up.

### 8.2 Desktop acceptance

- A burst of document-changing editor updates before the materialization timer
  fires causes no App-shell commit solely for cursor/mode refresh.
- StatusBar observes the latest cursor and mode.
- Materialization still occurs at the configured trailing interval.
- Recovery writes still receive the latest materialized contents.
- tab switches, source/live toggles, stale bindings, open/reset, and unmount
  publish or discard status correctly.
- existing App large-document, materialization, outline, normalization, save,
  recovery, find, and session tests pass.

### 8.3 Engine acceptance

- cache entry and retained-byte limits are enforced in tests;
- LRU hits refresh recency and oversize entries are not retained;
- concurrent first code renders share one Shiki initialization;
- load/highlight failures preserve plain source fallback;
- the production main chunk no longer eagerly includes the live-code Shiki
  core initialization path;
- target: main raw JavaScript chunk is at least 10% smaller than the
  1,226.70 kB baseline;
- if the size target is missed, implementation is not represented as complete
  until bundle composition is explained and the eager-loading requirement is
  independently verified;
- existing engine tests and advisory benchmarks have no new budget warning.

### 8.4 Rust acceptance

- existing search results and serialized shape remain unchanged;
- case sensitivity, UTF-16 offsets, line truncation, ignored files, non-UTF-8
  files, deterministic sorting, caps, and `truncated` behavior are covered;
- a multi-file concurrency test cannot exceed the cap;
- advisory before/after timing is recorded, but wall-clock timing is not a CI
  pass/fail condition;
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` passes.

### 8.5 Final integration

Run:

```sh
pnpm test
pnpm --filter @omd/engine bench
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm verify
```

There is no repository-wide lint or format command, so the implementation must
not claim such checks passed.

## 9. Implementation Dependencies

```text
Baseline measurements
  ├─ Workstream A: Desktop status boundary → focused App extraction
  ├─ Workstream B: LRU + lazy Shiki → optional benchmark-gated engine work
  └─ Workstream C: Rust local collection → optional quick-open batching
          \                |                 /
           └──────── Integration and full verification
```

Within Workstream A, the render boundary must land before broader extraction so
the behavioral improvement is isolated and measurable.

Within Workstream B, LRU and lazy loading may be separate commits. Optional
TableWidget/build-driver work follows its benchmark and must not block the
confirmed cache/loading improvements.

Within Workstream C, search collection lands before any quick-open batching.

## 10. Documentation

Implementation should update documentation only when the final code establishes
a reusable rule:

- `apps/desktop/AGENTS.md`: add the editor-status render boundary if it becomes
  a stable host invariant.
- `packages/engine/AGENTS.md`: document bounded code-render caching and lazy
  highlighter loading if future widget work must preserve them.
- `docs/memory/known-gotchas.md`: add an entry only if implementation uncovers a
  verified recurring trap.
- `docs/manual-qa.md`: update only if user-visible status timing or interaction
  behavior changes.
- README and changelog updates are not required for an internal optimization
  with unchanged user-visible behavior.

## 11. Rollback Strategy

Each workstream must be independently revertible:

- Desktop can restore App-owned status reads without changing document
  materialization or save behavior.
- Engine can restore eager Shiki loading independently from the bounded cache.
- Rust can restore the old collection strategy without changing the IPC shape.
- Optional TableWidget/build-driver changes are separate from the confirmed
  optimizations.

Commits should follow these boundaries so a regression in one subsystem does
not require discarding unrelated improvements.

## 12. Implementation Evidence

### Commands

```sh
git status --short
git --no-pager log -1 --oneline
pnpm --filter @omd/desktop build 2>&1 | tee /tmp/omd-desktop-build-before.log
pnpm --filter @omd/engine bench 2>&1 | tee /tmp/omd-engine-bench-before.log
time cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  search_caps_results_and_marks_truncated -- --nocapture
```

### Before

Baseline commit: `0990fee3e2ac1ef9e43223a3deb94a9b117d3d98`

| Metric | Before |
| --- | --- |
| Desktop main bundle | `dist/assets/index-BeHXo1aa.js`: `1,226.70 kB` raw / `410.07 kB` gzip |
| Desktop build duration | `vite build` finished in `4.53s` (`real 0m6.654s`) |
| Desktop chunk warnings | `(!) Some chunks are larger than 1200 kB after minification.` |
| Largest lazy chunks | `cynefin-VYW2F7L2-C6jhMPZs.js` `687.89 kB` raw / `154.14 kB` gzip; `mermaid.core-Bun_w9uL.js` `622.22 kB` raw / `149.16 kB` gzip; `cytoscape.esm-D3_iZ_3b.js` `442.92 kB` raw / `141.93 kB` gzip |
| Engine benchmark warnings | `92` `OVER BUDGET (> 8ms)` lines; the summary still reports `documentStats 50k` at `14.7908ms` p95 |
| Rust search baseline | `500 hits, truncated=true` |
| Rust wall clock | `real 0m3.542s` |

Vitest bench prints each benchmark body many times; the `92` `OVER BUDGET` lines are repeated iterations from one advisory family (`documentStats 50k`), not 92 distinct scenarios.
The Rust wall clock includes compilation and test-harness overhead from `cargo test`, so it is a baseline only and not directly comparable to the later ignored fixture benchmark.

### Engine families from the raw logs

Typing / parse / stats:

| Family | Raw-log value |
| --- | --- |
| `typing p95 10k live steady` | `8.35ms` |
| `typing p95 10k source steady` | `0.80ms` |
| `typing p95 50k source steady` | `0.70ms` |
| `typing p95 10MB source steady` | `0.81ms` |
| `typing p95 20MB source steady` | `0.85ms` |
| `typing p95 10MB live windowed steady` | `7.13ms` |
| `typing p95 10k live complete-tree` | `18.63ms` |
| `cold parse 10k` | `31.51ms` |
| `cold parse 50k` | `161.44ms` |
| `decoration rebuild 10k (live)` | `10.93ms` |
| `documentStats 50k` | `13.99ms` |

Open ingest / chunked Text / toggle:

| Family | Raw-log value |
| --- | --- |
| `open ingest 10MB (source, steady)` | `21.14ms` |
| `open ingest 20MB (source, steady)` | `44.42ms` |
| `open ingest 50MB (source, steady)` | `88.27ms` |
| `open ingest 10MB (live, steady)` | `12.52ms` |
| `open ingest 20MB (live, steady)` | `32.10ms` |
| `open ingest 10MB (string split, current)` | `20.78ms` |
| `open ingest 10MB (chunked Text assembly)` | `19.86ms` |
| `open ingest 50MB (string split, current)` | `80.57ms` |
| `open ingest 50MB (chunked Text assembly)` | `110.83ms` |
| `chunk splitter standalone 50MB` | `108.37ms` |
| `live toggle 10MB (source → live, seed)` | `toggle 10MB tx p95 0.33ms; toggle 10MB pure seedLiveDecorations p95 0.12ms` |
| `live toggle 20MB (source → live, seed)` | `toggle 20MB tx p95 6.19ms; toggle 20MB pure seedLiveDecorations p95 0.12ms` |


## 13. After Evidence and Final Decisions

Recorded from the final targeted integration run at `87c372e` and the completed
workstream reports.

### After

| Metric | After | Comparison / exact evidence |
| --- | --- | --- |
| Desktop main bundle | `dist/assets/index-DQi60M4P.js`: `1,064.15 kB` raw / `356.43 kB` gzip | Baseline raw was `1,226.70 kB`; the reduction was `162.55 kB` (`13.251%`). The 10%-below threshold was `1,104.03 kB`, so the target **passed** by `39.88 kB`. Vite reported 0 build warnings. |
| App-shell commits during the pre-materialization edit burst | `0` additional App-shell commits | `App.editorStatusRender.test.tsx` captures `before = topBarRender.mock.calls.length`, publishes status, emits a `docChanged` update while `docMaterializeMs: 250` has not fired, and asserts `expect(topBarRender).toHaveBeenCalledTimes(before)` after each operation. |
| Latest StatusBar cursor / mode | `4:2` / `source` | The same test publishes `{ cursor: "4:2", mode: "source" }` and asserts `screen.getByText("4:2")` and `screen.getByText("source")` before asserting the App-shell count is unchanged. |
| Live code highlighted-HTML cache | `128 entries / 8 MiB` | `CODE_HTML_CACHE_MAX_ENTRIES = 128`; `CODE_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024`; retained HTML uses deterministic UTF-16 accounting (`html.length * 2`). |
| Engine advisory budget warnings | `94` printed `OVER BUDGET` lines (`29` distinct measured values) | Every warning was the pre-existing `documentStats 50k` family over the unchanged `8 ms` budget; observed range `13.42–15.35 ms`, printed-sample average `13.6840 ms`. No typing, live-toggle, or new warning category exceeded budget. |
| Rust workspace search, 1,000 files × 200 lines | `42.10 ms` | Latest integration command printed `workspace search 1000x200: 42.10ms`; the ignored test also asserted `response.hits.len() == MAX_SEARCH_HITS` and `response.truncated`, preserving the 500-hit cap. The workstream's earlier final local run printed `37.12 ms`; timings are advisory and load-dependent. |
| Full repository gate | `pnpm verify` passed | Engine: `43` files / `441` tests; desktop: `73` files / `584` tests; Rust: `146` passed / `1` ignored; Vite transformed `4243` modules and built in `4.50s`; the Rust app binary linked successfully. |

The generated bundle graph independently confirms that the live-widget Shiki
implementation is no longer eager: `dist/index.html` eagerly loads only the main
JavaScript and CSS, while Shiki core is in the separate `113.60 kB` raw /
`36.26 kB` gzip `core-BXnl5npm.js` chunk, with the JavaScript engine and GitHub
themes also emitted as lazy chunks.

### Optional-work decisions

- **Build driver:** no build-selection algorithm or runtime behavior changed.
  Production `buildDriver.ts` changed only to export the existing
  `pendingInWindow` and `nearestChunk` helpers so the advisory benchmark could
  exercise the real path; they were not added to the engine's public
  `src/index.ts` API. The final `1000×64` benchmark mean was `100.52 ms` per
  benchmark invocation, whose fixture performs 1,000 measured passes
  (approximately `0.10052 ms/pass`). This did not demonstrate a material runtime
  problem, so the spec's optional two-pointer/direct-selection rewrite was not
  justified.
- **Quick open:** no production batching change. A temporary ignored fixture
  measured the existing `list_markdown_files_sync` path over exactly 5,000
  Markdown files at `23.12 ms`, while preserving the exact 5,000-path result,
  non-truncated semantics, and sorted output. The fixture was removed after the
  measurement because it showed no material mutex contention.
- **Main bundle:** the 10% raw-main target was met: `1,064.15 kB` is `13.251%`
  below `1,226.70 kB`.
- **Table widget equality:** no optional production equality optimization was
  made. Focused equality coverage was retained; there was no evidence requiring
  a representation or comparison change.

### Deviations and interpretation notes

- The baseline text said the engine benchmark suite passed without budget
  warnings, but the captured baseline actually contained `92` repeated
  `documentStats 50k` warnings. The final run contained `94` repeated lines in
  that same pre-existing family. Acceptance is therefore recorded as **no new
  warning category or optimization regression**, not zero warning lines.
- The pre-implementation Rust baseline used a different command and included
  compilation/test-harness wall time (`real 0m3.542s`), so it is not presented as
  a numeric speedup against the later deterministic `1000×200` in-test timer.
- The build-driver workstream made benchmark-only source visibility changes
  rather than the speculative algorithm rewrite. Quick-open likewise remained
  unchanged after measurement. These are intentional benchmark-gated outcomes,
  not missing implementation.
- The editor-status evidence uses `TopBar` as an App-shell render probe. The
  exact assertion is zero *additional* probe calls relative to the captured
  count, rather than an absolute mount-time React commit count.

### Documentation maintenance decision

The stable editor-status boundary is already recorded in
`apps/desktop/AGENTS.md`, and the bounded cache/lazy single-flight Shiki
invariants are already recorded in `packages/engine/AGENTS.md`. The visible
status timing checks are already present in `docs/manual-qa.md`. No newly
verified recurring trap was found for `docs/memory/known-gotchas.md`, and there
was no user-visible behavior or setup change requiring README or changelog
updates.
