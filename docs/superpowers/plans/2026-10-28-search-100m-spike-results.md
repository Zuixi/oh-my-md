# 100 MiB Search Spike Results

> Evidence report for [`2026-10-28-search-100m-spike.md`](./2026-10-28-search-100m-spike.md).
> Decision gates come from [`2026-10-28-editor-experience-spike-program-design.md`](../specs/2026-10-28-editor-experience-spike-program-design.md) (Spike 2).
>
> Every number below is copied from a run recorded in this worktree's session logs or from the
> persisted Chromium audit JSON (`/tmp/omd-search-audit.json`). Nothing is estimated. Each row is
> labelled with its evidence class:
>
> - **Unit** — Vitest in Node/happy-dom with fake clocks and `Text` Proxy guards.
> - **Benchmark** — `vitest bench` in Node over real `@codemirror/state` `Text`.
> - **Chromium** — Playwright driving real Chrome, heap numbers through CDP.

## Environment and Commit

| Item | Value |
| --- | --- |
| Worktree | `.worktrees/editor-experience-spikes` |
| Branch | `codex/editor-experience-spikes` |
| Base commit | `80efba5` (Merge pull request #41). All spike code is uncommitted worktree state; the plan forbids committing during the spike. |
| OS / arch | darwin / arm64 |
| Node (bench + audit) | v26.7.0 |
| Vitest | 3.2.7 |
| Vite dev server | 7.3.6 (port 9475 for the final audit) |
| Audit JSON | `/tmp/omd-search-audit.json` — pretty-printed JSON that parses with `jq`, `port: "9475"`, `failed: []` |
| Browser (Chromium evidence) | Google Chrome `156.0.8078.48`, `channel: "chrome"`, viewport 1200×900, fresh page per scenario |
| New dependency | `@codemirror/search@^6.7.2` (desktop) |

No 100 MiB file was written to disk: fixtures are built in memory as `Text` and dropped after each
scenario.

## Commands

```sh
# the three spike test files (57/57 total; currentDocumentSearch.test.ts is 38/38, searchCountJob.test.ts is 14/14)
pnpm --filter @omd/desktop exec vitest run test/searchFixtures.test.ts test/currentDocumentSearch.test.ts test/searchCountJob.test.ts
pnpm --filter @omd/desktop test                      # tsc -p tsconfig.test.json && vitest run -> 915 passed across 90 files
pnpm --filter @omd/desktop build                    # PASS
pnpm --filter @omd/desktop test:e2e -- search-worker-spike.spec.ts   # runs the whole E2E suite -> 74 passed
pnpm --filter @omd/desktop bench:search-spike        # vitest bench --run bench/search.bench.ts --reporter=verbose
# dev server must already be listening on the same port
PW_PORT=9475 pnpm --filter @omd/desktop dev -- --host 127.0.0.1 --port 1420
PW_PORT=9475 pnpm --filter @omd/desktop audit:search-spike   # writes /tmp/omd-search-audit.json
```

Suite results on the final tree: engine `950 passed (950)` across 73 files (`pnpm test`, with
`tsc --noEmit`), desktop `915 passed (915)` across 90 files (including 16 KiB window boundary
self-overlap and NFKD ligature non-overlapping count parity in `searchCountJob.test.ts`, and
over-scale Find/Replace navigation in `App.test.tsx`), full desktop E2E `74 passed` including the
five Worker tests, `currentDocumentSearch.test.ts` `38 passed (38)`, `git diff --check` clean.

## Fixture Construction

**Benchmark** (`bench/searchFixtures.ts`, timers start after construction; 100 MiB = 104,857,600 chars):

| Fixture | Chars | Lines (Unit) | Literal hits | Construction (Benchmark) |
| --- | ---: | ---: | ---: | ---: |
| `normal-10m` | 10,485,760 | 329,067 | 160 | not in the timed report |
| `normal-100m` | 104,857,600 | 3,270,542 | 1,600 | 222.917 ms |
| `dense-100m` | 104,857,600 | 819,201 | 819,200 | 75.857 ms |
| `long-line-20m` | 20,971,520 | 1 | 6 | 2.230 ms |
| `unicode-100m` | 104,857,600 | 3,201 | 1,600 | not in the timed report |

`normal-*` is a repeated 64 KiB Markdown paragraph period with exactly one `needle` per period
(offsets `N * 65536 + 27`); `dense-100m` has one hit every 128 bytes and exposes only 16 recorded
offsets plus `expectedLiteralCount = 819200`; `long-line-20m` is one logical line with hits at
`[1024, 1 MiB, 5 MiB, 10 MiB, 15 MiB, 19 MiB]`. Construction pushes ≤64 KiB chunks straight into
`createTextAssembler()`; no document string, no `toString()`, no chunk array.

Reconstruction is deterministic: the fixture unit tests assert exact length, first/middle/last
offset, hit-line text, per-period hit count, and line count (160/1600 hits; the line counts above).
An earlier run of the same generators built `normal-100m` in 255.213 ms, `dense-100m` in 76.782 ms
and `long-line-20m` in 1.633 ms, and a mid-spike run reported 222.005 / 72.202 / 2.131 ms;
construction cost varies with machine state, the fixtures do not.

## Navigation Latency

**Benchmark** — 5 warm-ups, 30 samples per scenario, timers around the cursor call only. The
per-scenario table is the first recorded run; the final rerun after the search fixes is the second
table.

| Scenario | Anchor | Next hit | p50 | p95 | peak |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 0 | 27 | 0.010 ms | 0.024 ms | 0.027 ms |
| middle | 52,428,800 | 27 | 0.012 ms | 0.020 ms | 0.022 ms |
| end | 104,791,067 | within 1 MiB | — | 0.024 ms | — |
| wrap | document end | first hit | — | 0.031 ms | — |

Final rerun (the numbers used in the decision):

| Metric | Value |
| --- | ---: |
| next-hit gate worst p95 (`start` / `middle` / `end`, ≤ 1 MiB) | 0.079 ms |
| next-hit `wrap` p95 | 3.821 ms |
| previous hit from the 100 MiB tail, p95 (1 window, 256 KiB) | 12.337 ms |

The only absolute gate in this spike — `normal-100m` next-hit p95 ≤ 100 ms for hits within 1 MiB —
reported `worstP95Ms: 0.079`, `scenarios: ["start","middle","end"]`, `pass: true` (earlier runs of
the same code reported `0.094` and `0.081`). The gated scenarios are three orders of magnitude inside
the gate; the gate exists to catch accidental full-scan regressions, not to measure a tight budget.

`wrap` is outside that gate (measured, not gated): 3.821 ms p95 in the final rerun. The first run
recorded `0.031 ms` for the same row, and that number does not reproduce — two later runs (3.821 and
3.76 ms) agree, so the current value is the one to use. The cost is the cursor, not the windowing:
wrapping after the last hit must first scan the hit-free 65,503-char tail, and a literal no-hit
`SearchCursor` scan measures ~41 ms/MiB on this machine in a standalone probe (64 KiB ≈ 2.7 ms,
256 KiB ≈ 10.6 ms, 1 MiB ≈ 42 ms), which also lines up with the ~12 ms previous-search window. A
production design that cares about wrap latency should enter at the document start or reuse a
remembered first hit instead of scanning the tail first.

**Previous navigation and window evidence** — this is feasibility evidence for the expanding-window
design, not a new gate. Anchor at the document tail (104,857,600), nearest hit 65,509 chars earlier:

| Field | Value |
| --- | --- |
| Match | 104,792,091 → 104,792,097 (`matchesExpected: true`) |
| p50 / p95 / peak (n=30) | 11.832 / 11.972 / 11.998 ms in the first run; **12.337 ms p95 in the final rerun** |
| `cursorWindows` | 1 (no expansion needed) |
| `earliestSearchedOffset` | 104,595,456 = anchor − 262,144 (256 KiB) |
| `initialWindowChars` | 262,144 |

The vitest per-iteration row for the same call is `83.2 hz`, mean 12.019 ms — consistent.

Previous navigation is the one deliberately expensive path: `SearchCursor`/`RegExpCursor` only
iterate forward, so the spike starts at `[anchor − 256 KiB, anchor)` and doubles the reach only when
that window is empty. Doubling no longer rescans work already proven empty for literals: each round
scans only the newly exposed left interval plus a `query-length − 1` overlap, so total scanned
characters stay within `stop + rounds × overlap`. The overlap is computed from the NFKD-normalized
query length (NFKD, then lowercased when case-insensitive), because the cursor applies that same
normalization and a precomposed `é` expands to two code units — a raw `query.length − 1` would drop a
decomposed match straddling the window boundary. A one-character literal gets overlap `0`, and is
distinguished from the regex path by `overlap === null` rather than by truthiness. Regex keeps the
cumulative `[edge − reach, edge)` window because no finite overlap guarantees no missed match for an
unbounded pattern. **Unit** tests pin all of it with an instrumented `Text`: exact range ladders for a
multi-character literal, a one-character literal and a wrap from the document end; no repeated scan
of the collapsed prefix; the composed/decomposed `é` boundary case; regex correctness across windows;
and a 100 MiB previous search that never opens a range starting at 0.

## Count Slicing and Cancellation

Counting is a cancellable job that walks the document in bounded windows
(`WINDOW_CHARS = 16 KiB`, `Math.max(WINDOW_CHARS, overlap + 1)`, overlap = query length − 1) and
keeps only a scalar count plus the current window cursor. A candidate is counted only when
`from ∈ [windowFrom, windowTo)`, which makes overlap duplicates impossible.

**Benchmark** — `sliceMs: 4`, `sliceBudgetMs: 12`, display cap 10,000:

| Stage | Fixture | Count | Complete | Slices | Worst slice | Verdict |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Before correction | `normal-100m` | 1,600 | true (5,023.98 ms) | 26 | **206.841 ms** | failed the 12 ms gate |
| After correction | `normal-100m` | 1,600 | true | 1,076 | **4.781 ms** | passes |
| Before correction | `dense-100m` | 10,000 | false (61.034 ms) | 15 | 4.416 ms | passes |
| After correction | `dense-100m` | 10,000 | false | 15 | **5.185 ms** | passes |

The corrected run is the failing case fixed (see [Failed Cases](#failed-cases)); the pre-correction
numbers are kept in this report instead of being overwritten. The corrected `count` block quotes
slices and worst slice only: its `completionMs` is dominated by the 4 ms yield cadence, varies run to
run (a rerun measured 4,992 ms), and is therefore not used as evidence.

**Chromium** — the audit measures the same two counts end to end on a real page (no per-slice
instrumentation in the browser, so browser evidence proves cap/termination, not slice duration):

| Fixture | Count | Complete | Wall clock | Publishes |
| --- | ---: | --- | ---: | ---: |
| `dense-100m` | 10,000 | false | 76.7 ms | 1 |
| `normal-100m` | 1,600 | true | 10,242.2 ms | 1 |

Chromium count wall clock varies between runs of the same code (a rerun of this audit measured
82.8 ms and 10,686.4 ms); the cap, completeness, publish count and heap numbers are the stable
parts. A complete 100 MiB literal count is ~10 s in the browser — that is the number a production
design has to surface as a progress state, not hide.

The display cap never leaks into replacement: the cap is applied in `searchCountJob.ts` only, and
`buildReplaceAll` runs its own cursor to completion.

**Cancellation and cap** — the cap publishes `{ count: 10_000, complete: false, revision }` and stops;
cancellation releases the queued callback, sets a terminal flag, and blocks late publishes.

| Evidence | Measurement |
| --- | --- |
| Benchmark | `cancellationMs: 0.001`, `publishedBefore: 0`, `publishedAfter: 0`, `stalePublish: false`, `pendingCleared: true`, `cancelled: true` |
| Chromium `dense-100m` | `cancellationMs: 0`, `publishedAfter: 0`, `stalePublish: false`, `countMatchesCap: true` |
| Chromium `normal-100m` | `cancellationMs: 0`, `publishedAfter: 0`, `stalePublish: false` |
| Unit | fake-clock tests: yields at the slice budget instead of draining, superseded revision never publishes, dense caps exactly at 10,000, sparse finishes exact, no double publish, explicit `sliceMs`/`cap` honoured |

## Semantic Parity

**Unit** — `currentDocumentSearch.test.ts` runs the delivered semantics beside the unchanged
`findReplace.test.ts` (left untouched on purpose, so old and new behaviour stay comparable):

- empty query, literal punctuation, case sensitivity, next/previous wrap, query reset from the
  current selection;
- ASCII whole word, CJK whole word (never blocked), zero-length regex skip, invalid regex text;
- viewport-only enumeration with a two-range input and a 1,000-match cap, no implicit full-document
  range;
- `matchStillValid` rejects stale revisions, out-of-range and text-mismatched matches;
- `searchRevisionField` starts at 0 and increments once per doc-changing transaction only.

## Replace-All Evidence

**Benchmark** (`normal-100m`, sparse literal replace-all, replacement text `REPLACED`):

| Field | Value |
| --- | --- |
| Replacements | 1,600 / 1,600 expected |
| Elapsed | 4,960.961 ms |
| `originalUnchanged` | true |
| `originalHitIntact` | true |

Replace-all builds one `ChangeSet` for the captured revision, never calls the display counter, never
materializes the document, and does not stop at 10,000 (unit test: "replaces every match even past
the 10,000 display cap"). Replace-current validates `active.revision`, range bounds and candidate text
against live state and falls back deterministically to the next match — all pinned by unit tests,
including the pending/truncated-count cases.

**Replacement templates are deliberately narrow:** only `$$`, `$&` and numeric `$1…$99` are expanded.
`` $` ``, `$'` and `$<name>` stay literal — prefix/suffix insertion would slice the whole document per
replacement, which is exactly what this spike refuses to do, and named groups are not implemented.
No `Text` insert and no prefix/suffix document text is ever materialized; unit tests assert the
unsupported tokens stay literal in replace-current **and** in a many-match replace-all.

## Regex Worker Evidence

**Chromium** — `e2e/search-worker-spike.spec.ts`, real browser, all five tests pass:

| Test | Result |
| --- | --- |
| helper only exists behind `?searchSpike=1` | pass |
| invalid regex returns a structured error | pass |
| ordinary regex returns UTF-16 offsets, including surrogate pairs | pass |
| catastrophic regex stays off the main thread until `terminate()` | pass |
| a response carrying an old revision is ignored | pass |

The main editor keeps accepting transactions (a selection change is asserted) while the pathological
pattern runs inside the Worker, and `terminate()` ends it. The Worker receives a plain
`{ id, revision, source, flags, text }` message — never an `EditorView`, never application state — so
no persistent document mirror exists. Worker use is harness-only: production code never imports it.

The main thread never puts a timeout around synchronous `RegExp` execution; isolation is achieved by
not running unbounded user regex on the main thread at all.

## Heap Evidence

**Chromium** — CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`, fresh page per scenario,
sampled at baseline / post-construction / post-count / post-cancellation / post-release:

| Fixture | baseline | post-construction | post-count | post-cancellation | post-release |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dense-100m` | 5.5 MB | 27.2 MB | 27.4 MB | 27.4 MB | 5.7 MB |
| `normal-100m` | 5.5 MB | 182.1 MB | 182.4 MB | 182.5 MB | 5.7 MB |

| Gate | `dense-100m` | `normal-100m` |
| --- | ---: | ---: |
| count delta over post-construction (limit 32 MiB) | 113,776 B (0.1 MB) | 313,412 B (0.3 MB) |
| release delta over baseline | 0.2 MB | 0.2 MB |
| fixture delta over baseline | 21.7 MB | 176.6 MB |

Dense counting adds 0.1 MB and the sparse 100 MiB count adds 0.3 MB over their own
post-construction heap, in both cases on top of the fixture; the
100 MiB `Text` itself is freed on release in both scenarios (5.7 MB is the post-`view.destroy()`
baseline, not a retained document). The `dense-100m` fixture costs only 21.7 MB because repeated
128-byte periods dedupe into shared `TextNode`s — that is a property of the fixture generator, not a
claim about a real 100 MiB document.

Vitest/happy-dom heap numbers are deliberately **not** used anywhere in this report.

**No-stringify / no-array guards** (the gate "no timed path calls `Text.toString`,
`sliceString(0, doc.length)`, or builds a full match array"):

| Evidence | Counter | Value |
| --- | --- | --- |
| Benchmark guarded pass | `stringifyCalls` / `wholeDocumentSliceCalls` / `largestSliceChars` / `iterRangeCalls` | 0 / 0 / 0 / 33 (`navigationMatched: true`) |
| Chromium guards (`dense-100m`, `normal-100m`) | `stringifyCalls` / `wholeDocumentSliceCalls` | 0 / 0 |
| Chromium guards | `matchArraysRetained` | 0 (constant: the spike API has no match-array field at all) |
| Chromium guards | `countPublishes` after cancel | 0 |
| Unit guards | `Text` Proxy counting `toString` / `sliceString` / `iterRange` | zero stringify, no `sliceString(0, length)` in next/previous/wrap and in the 100 MiB navigation case |

The `matchArraysRetained: 0` counter is a structural assertion, not an instrumented one — the real
anti-materialization proof is the unit Proxy guards plus `countPublishes`/`iterRangeCalls` counts.

## Failed Cases

1. **Sparse count slice ≈206 ms (fixed).** The first benchmark was a hard failure: `normal-100m`
   count reported a warmed worst slice of 206.841 ms against a 4 ms target, because
   `SearchCursor.next()` can scan a huge sparse region before returning and the per-candidate time
   check cannot bound work inside one call. Fixed in `searchCountJob.ts` only, by walking bounded
   16 KiB windows with query-length overlap and yielding after each window. Verified by three new
   deterministic tests (100 MiB sparse: >100 callbacks, ≤5 windows per callback, windows tile
   exactly, exact count; boundary hits before/after each real window start counted once; regex stays
   on the single unwindowed cursor) and by mutation checks — removing the dedupe bound (15 vs 12),
   dropping the overlap (9 vs 12) and disabling windowing each fail the suite. Re-measured worst
   slice: **4.781 ms** (dense: 5.185 ms). Resolved.
2. **Follow-up search tuning: 8 intentional RED tests, then 38/38 green.** The final pass over
   previous-search and replacement semantics was written test-first — the new cases were red before
   the change and `currentDocumentSearch.test.ts` now reports 38/38. What changed: literal previous
   search scans only the newly exposed prefix plus a normalization-aware overlap instead of
   re-scanning the already-proven empty suffix on every doubling; the overlap is derived from the
   NFKD-normalized query length so composed/decomposed `é` matches survive a window boundary; a
   one-character literal keeps overlap `0` and is not misclassified as regex (the regex path passes
   `null`, not `0`); and replacement templates were cut down to `$$`, `$&` and numeric `$1…$99`,
   with unsupported `` $` ``, `$'`, `$<name>` left literal so nothing materializes document
   prefix/suffix text. No gate changed, and the `Go` below does not claim named, prefix or suffix
   template support.
3. **Benchmark harness errors during Task 6 (fixed).** Early runs threw
   `TypeError: text.iterRange is not a function` because the benchmark passed the fixture object
   rather than `fixture.text`. A harness bug, never a gate failure; fixed before the recorded run.
4. **Not measured, recorded as such.** `unicode-100m` and `normal-10m` have unit coverage (shape,
   offsets, counts) but no navigation/count/heap rows, and no per-slice duration is instrumented in
   Chromium. `Table`-related and other spikes' E2E failures appearing in earlier full-suite logs
   belong to sibling spikes, not to this one.

## Decision

All Spike 2 `Go` conditions are satisfied:

| Gate | Result |
| --- | --- |
| No timed path stringifies, whole-document-slices, or retains a match array | pass (Benchmark + Chromium counters, unit Proxy guards) |
| `normal-100m` literal first-hit p95 ≤ 100 ms within 1 MiB | pass, 0.079 ms |
| Worst warmed count slice ≤ 12 ms | pass after correction, 4.781 ms |
| Cancellation observed before any stale publish | pass (Benchmark + Chromium + unit) |
| Replace-current / wrapping / query reset correct while count pending or capped | pass (unit) |
| Semantic parity incl. ASCII/CJK whole word, invalid regex, literal and capture replacement, exact replace-all | pass (unit, 38/38) |
| Replace-all one revision-validated transaction, no cap | pass (1,600/1,600, source untouched, unit test past the cap) |
| Dense cap 10,000 with heap growth < 32 MiB | pass, 113,776 B (0.1 MB) in Chromium |
| Long-line fixture responsive with exact offsets | pass (`long-line-20m` first-hit p95 0.054 ms; all 6 offsets exact) |
| Pathological regex isolated and terminable | pass (5/5 Worker E2E) |

**Decision: Go**

Scope of that `Go`: **literal-first search over `Text`, with regex isolated in a Worker**. The
literal/whole-word kernel is proven at 100 MiB; regex is proven *containable*, not proven cheap — no
gate in this spike bounds pathological regex latency, so large-document regex stays behind Worker
isolation and off the default path until a production design says otherwise.

## Production Recommendation

The spike is a kernel, not a product. `App.tsx`, `FindReplaceBar` and the shipped
`apps/desktop/src/findReplace.ts` are **unchanged**; nothing in this worktree is imported by
production code. Before migration, a separate approved design must decide:

- **React lifecycle** — who owns the job (component, ref, editor extension) and how `revision` +
  `queryId` flow from the React find bar into `startSearchCount`, including unmount cancellation.
- **User-visible truncated count** — how `{ count, complete: false }` is surfaced (e.g. "10,000+") and
  what the available actions are while a count is incomplete. A complete 100 MiB literal count takes
  ~10 s in Chromium (10,242.2 ms measured), so an incomplete count is the normal state on large
  documents, not an edge case.
- **Large-document replace-all** — exact replace-all took 4,960.961 ms at 100 MiB; the design must
  choose between a blocking one-shot transaction, a staged/confirmable flow, or a documented size
  limit. This is a product decision, not a kernel one. The supported replacement template set is
  deliberately narrow (`$$`, `$&`, `$1…$99`); a richer template language is a separate design.
- **Worker lifecycle and permissions** — bundling `searchRegex.worker.ts` through Vite, per-window
  worker reuse, termination on document close, and whether regex is enabled by default for large
  documents at all.
- **Semantic cutover** — porting `findReplace.ts` behaviour (and its tests) onto
  `currentDocumentSearch.ts`, then deleting the duplicate path rather than running both.
- **Out of scope, permanently** — Markdown-specific search semantics belong to the engine;
  current-document search must not move into Rust or import the Markdown parser.

## Prototype Files: Keep, Rewrite, Delete

| File | Action | Why |
| --- | --- | --- |
| `apps/desktop/src/currentDocumentSearch.ts` | **Keep** | Literal/whole-word/regex navigation, active-match validation, replace-current, exact replace-all. Migration-ready; needs React-facing glue only. |
| `apps/desktop/src/searchRevision.ts` | **Keep** | Minimal `StateField` revision counter; required by every async result. |
| `apps/desktop/src/searchCountJob.ts` | **Keep** | Windowed cancellable count with O(1) state. Contains the corrected sparse-window logic. |
| `apps/desktop/src/searchRegex.worker.ts` | **Keep** | Disposable per-request worker; the only regex isolation path proven here. |
| `apps/desktop/test/currentDocumentSearch.test.ts`, `test/searchCountJob.test.ts`, `test/searchFixtures.test.ts` | **Keep** | Behavioural contract, sparse-window regressions, deterministic fixtures. |
| `apps/desktop/bench/searchFixtures.ts` | **Keep** | Deterministic 10/100 MiB fixtures; any future large-document work needs them. |
| `apps/desktop/bench/search.bench.ts` | **Rewrite into the advisory suite** | Useful budgets, but it mounts a dev-only JSON report and a duplicate `describe` block for vitest's collect/worker contexts. Fold the rows into the existing `bench/` conventions when this leaves spike status. |
| `apps/desktop/e2e/search-100m-audit.mjs` | **Keep (manual tooling)** | Persisted heap evidence and gate logic; keep out of CI like `audit:widget-memory`. |
| `apps/desktop/e2e/search-worker-spike.spec.ts` | **Keep (fold into E2E)** | The only real-browser proof that a pathological regex cannot block the editor. |
| `?searchSpike=1` harness block in `apps/desktop/e2e/harness.ts` | **Delete when the harness is no longer needed** | ~280 lines of opt-in globals; production must not carry a fixture-building hook. |
| `package.json` `bench:search-spike` / `audit:search-spike` scripts | **Keep until migration** | Cheap, explicit entry points for re-measuring. |
| `docs/superpowers/plans/2026-10-28-search-100m-spike.md` | **Keep** | Historical plan; this report is its outcome. |

**Decision: Go**
