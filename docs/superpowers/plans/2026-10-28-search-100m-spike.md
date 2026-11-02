# 100 MiB Current-Document Search Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that current-document find navigation, bounded counting, and delivered replacement semantics can operate on CodeMirror `Text` at 100 MiB without full string materialization, retained match arrays, stale results, or unbounded main-thread work.

**Architecture:** Build a desktop-owned search kernel over CodeMirror's official cursor APIs. Navigation stops at the first match, count runs as a cancellable 4 ms sliced job with a 10,000 display cap, and replacement derives transactions from the active match rather than an array index. Regex syntax/semantic parity is tested separately, with pathological execution isolated in a disposable Worker.

**Tech Stack:** TypeScript, `@codemirror/state`, `@codemirror/view`, `@codemirror/search`, React-owned orchestration boundaries, Vitest, Playwright Worker/Chromium, deterministic chunked `Text` fixtures.

**Spec:** `docs/superpowers/specs/2026-10-28-editor-experience-spike-program-design.md`

## Global Constraints

- Search semantics stay generic and desktop-owned; do not import Markdown parsing or move current-document search into Rust.
- No timed 100 MiB navigation/count path may call `Text.toString()`, `sliceString(0, doc.length)`, or retain a full array of matches.
- Navigation and replace-current never wait for count completion and never use a numeric index into a materialized match array.
- Count slices target 4 ms, stop display counting at 10,000, and publish `{ complete: false }` at the cap.
- Every async result carries a document revision and query id; stale count/Worker results are discarded.
- Preserve delivered semantics: next/previous wrap, query reset, case mode, ASCII/CJK whole-word behavior, invalid-regex error state, literal replacement, regex captures, and exact replace-all.
- The display-count cap must never mean "replace only 10,000".
- The spike does not replace the production React find bar. Production migration requires a separate approved design after the result.
- Do not commit during execution unless the user separately authorizes commits.

---

## File Structure

- Create `apps/desktop/src/currentDocumentSearch.ts` — pure cursor navigation, active-match validation, replace-current, replace-all, and query validation.
- Create `apps/desktop/src/searchCountJob.ts` — cancellable scheduled counting with revision/query guards.
- Create `apps/desktop/src/searchRevision.ts` — CodeMirror StateField that increments on document changes.
- Create `apps/desktop/src/searchRegex.worker.ts` — disposable regex worker protocol used only by the spike harness.
- Create `apps/desktop/test/currentDocumentSearch.test.ts` — semantic parity and no-materialization tests.
- Create `apps/desktop/test/searchCountJob.test.ts` — deterministic scheduler/cancellation/slice tests.
- Create `apps/desktop/bench/searchFixtures.ts` — deterministic chunked `Text` fixture generator.
- Create `apps/desktop/bench/search.bench.ts` — 10/100 MiB navigation/count/heap benchmark.
- Create `apps/desktop/e2e/search-worker-spike.spec.ts` — real Worker termination and stale-result test.
- Create `apps/desktop/e2e/search-100m-audit.mjs` — real Chromium/CDP heap and target-size evidence.
- Modify `apps/desktop/e2e/harness.ts` only to expose the worker spike helper behind `?searchSpike=1`.
- Modify `apps/desktop/package.json` and `pnpm-lock.yaml` — explicit `@codemirror/search` dependency and spike benchmark script.
- Create `docs/superpowers/plans/2026-10-28-search-100m-spike-results.md` — measured evidence and decision.

### Task 1: Dependency and Deterministic `Text` Fixtures

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/bench/searchFixtures.ts`
- Create: `apps/desktop/test/searchFixtures.test.ts`

**Interfaces:**
- Consumes: `createTextAssembler()` from `@omd/engine`.
- Produces:

```ts
export type SearchFixtureName =
  | "normal-10m"
  | "normal-100m"
  | "dense-100m"
  | "long-line-20m"
  | "unicode-100m"

export interface SearchFixture {
  readonly name: SearchFixtureName
  readonly text: Text
  readonly expectedLiteralOffsets: readonly number[]
  readonly expectedLiteralCount: number
}

export function buildSearchFixture(name: SearchFixtureName): SearchFixture
```

- [ ] **Step 1: Add the official search package explicitly**

Run: `pnpm --filter @omd/desktop add @codemirror/search`

Expected: desktop manifest and lockfile contain one compatible CodeMirror 6 search package; no unrelated dependency changes.

- [ ] **Step 2: Write fixture-shape tests**

Assert exact `Text.length`, deterministic first/middle/last offsets, line count, and content around each hit. Cover:

- `normal-10m` and `normal-100m`: short Markdown-like paragraphs, `needle` every 64 KiB;
- `dense-100m`: `needle` every 128 bytes;
- `long-line-20m`: one logical line with sparse hits;
- `unicode-100m`: CJK/emoji around sparse hits.

- [ ] **Step 3: Run the fixture test and verify failure**

Run: `pnpm --filter @omd/desktop exec vitest run test/searchFixtures.test.ts`

Expected: FAIL because `buildSearchFixture` does not exist.

- [ ] **Step 4: Implement bounded chunk assembly**

Generate fixed-size chunks no larger than 256 KiB and push each into `createTextAssembler`. Do not accumulate all chunks in an array and do not join and split the full document.

For the long-line fixture, push repeated no-newline chunks and insert known hits at recorded absolute offsets. Return only the sparse expected-offset list; for `dense-100m`, keep the first 16 offsets plus `expectedLiteralCount` rather than all offsets.

- [ ] **Step 5: Run the focused test**

Run: `pnpm --filter @omd/desktop exec vitest run test/searchFixtures.test.ts`

Expected: PASS without committing generated fixture files.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/package.json pnpm-lock.yaml apps/desktop/bench/searchFixtures.ts apps/desktop/test/searchFixtures.test.ts`

Expected: deterministic generator; no large artifacts in the repository.

### Task 2: Revision and Literal Navigation Kernel

**Files:**
- Create: `apps/desktop/src/searchRevision.ts`
- Create: `apps/desktop/src/currentDocumentSearch.ts`
- Create: `apps/desktop/test/currentDocumentSearch.test.ts`
- Read: `apps/desktop/src/findReplace.ts`
- Read: `apps/desktop/test/findReplace.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SearchRequest {
  readonly query: string
  readonly caseSensitive: boolean
  readonly regexp: boolean
  readonly wholeWord: boolean
  readonly revision: number
}

export interface SearchMatch {
  readonly from: number
  readonly to: number
  readonly revision: number
}

export interface MatchCursor {
  next(): SearchMatch | null
}

export const PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS = 256 * 1024
export const searchRevisionField: StateField<number>
export function currentSearchRevision(state: EditorState): number
export function validateSearchRequest(request: SearchRequest): string | null
export function findNextMatch(
  doc: Text,
  request: SearchRequest,
  anchor: number,
): SearchMatch | null
export function findPreviousMatch(
  doc: Text,
  request: SearchRequest,
  anchor: number,
): SearchMatch | null
export function matchStillValid(doc: Text, request: SearchRequest, match: SearchMatch): boolean
export function createMatchCursor(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): MatchCursor
export function collectViewportMatches(
  doc: Text,
  request: SearchRequest,
  ranges: readonly { readonly from: number; readonly to: number }[],
  limit?: number,
): readonly SearchMatch[]
```

- [ ] **Step 1: Port the current semantic tests before implementation**

Create parity cases for empty query, literal punctuation, case sensitivity, next/previous wrap, query reset from current selection, ASCII whole-word, CJK whole-word, zero-length regex rejection, invalid regex text, and match enumeration limited to two supplied viewport ranges. Keep the existing `findReplace.test.ts` unchanged so old and new behavior are visible side by side.

Instrument cursor construction for previous navigation. With the anchor near the end of a 100 MiB fixture and the nearest hit 64 KiB earlier, assert the first and only searched range starts at `anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS`, not at document position `0`. Add a second case with no nearby hit and assert window sizes expand in order from 256 KiB to 512 KiB to 1 MiB. Add a wrap case that exhausts `[0, anchor)` before applying the same expanding-window search to `[anchor, doc.length)` from the document end.

- [ ] **Step 2: Add a no-materialization guard**

Wrap a real `Text` in a test harness that spies on `toString` and rejects any `sliceString(0, doc.length)` call. Navigate next to a hit near the beginning, previous to a hit near the 100 MiB tail, and across wrap in both directions; assert no forbidden operation occurs, no match array is returned, and the near-tail previous case never opens a cursor over the full prefix.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm --filter @omd/desktop exec vitest run test/currentDocumentSearch.test.ts`

Expected: FAIL because the new module does not exist.

- [ ] **Step 4: Implement revision tracking**

Define a StateField initialized to `0` and incremented once for each transaction with `docChanged`. Non-document selection and reconfiguration transactions retain the revision.

- [ ] **Step 5: Implement cursor navigation**

Use `SearchCursor` directly over `Text` for literals and `RegExpCursor` for normal regex input. Supply a lowercase normalizer only when case-insensitive. For whole-word mode, test the characters immediately outside a literal candidate using small `sliceString` calls; add ASCII boundaries only when the corresponding query edge matches `/\w/`, preserving current CJK behavior. Reject zero-length regex matches.

Search `[anchor, doc.length)` first and then `[0, anchor)` for next.

`SearchCursor` and `RegExpCursor` expose forward iteration only, so previous navigation must not compensate by scanning `[0, anchor)` on every invocation. Start with `[max(0, anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS), anchor)`, iterate forward within that window, and retain only the latest scalar match. If the window has no match, double its width and retry the expanded range; stop at the first window containing a match. The deliberate overlap between expanded ranges preserves correctness for regex matches that cross an earlier window boundary. If `[0, anchor)` is exhausted without a match, apply the same 256 KiB doubling search from `doc.length` toward the lower bound `anchor` and return the latest match in the first populated wrap window. Clamp arithmetic before doubling so documents near `Number.MAX_SAFE_INTEGER` cannot overflow. Never accumulate a match list.

`collectViewportMatches` creates one cursor per supplied range, returns only matches intersecting those ranges, defaults to a 1,000-match viewport cap, and never accepts an implicit full-document range.

- [ ] **Step 6: Run semantic and legacy tests**

Run:

```bash
pnpm --filter @omd/desktop exec vitest run test/currentDocumentSearch.test.ts test/findReplace.test.ts
```

Expected: PASS with parity for all delivered literal/whole-word cases.

- [ ] **Step 7: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/src/searchRevision.ts apps/desktop/src/currentDocumentSearch.ts apps/desktop/test/currentDocumentSearch.test.ts`

Expected: no React imports and no Markdown parsing.

### Task 3: Cancellable Bounded Count Job

**Files:**
- Create: `apps/desktop/src/searchCountJob.ts`
- Create: `apps/desktop/test/searchCountJob.test.ts`

**Interfaces:**
- Consumes: `SearchRequest`, `Text`, and `createMatchCursor` from Task 2.
- Produces:

```ts
export interface SearchCount {
  readonly count: number
  readonly complete: boolean
  readonly revision: number
}

export interface SearchScheduler {
  now(): number
  schedule(run: () => void): () => void
}

export interface SearchCountJob {
  cancel(): void
  readonly cancelled: boolean
}

export function startSearchCount(
  doc: Text,
  request: SearchRequest,
  scheduler: SearchScheduler,
  publish: (count: SearchCount) => void,
  options?: { readonly sliceMs?: number; readonly cap?: number },
): SearchCountJob
```

- [ ] **Step 1: Write deterministic scheduler tests**

Use a fake scheduler whose `now()` advances from controlled cursor steps. Assert:

- each callback stops at or after the 4 ms budget instead of draining the document;
- count state retains only cursor/count/revision, not matches;
- a new query cancellation prevents all later publishes;
- revision mismatch prevents publish;
- dense input publishes `{ count: 10_000, complete: false }`;
- sparse input publishes exact `{ complete: true }`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @omd/desktop exec vitest run test/searchCountJob.test.ts`

Expected: FAIL because `startSearchCount` does not exist.

- [ ] **Step 3: Implement resumable cursor slices**

Keep one cursor instance and scalar count across callbacks. Check elapsed time after each bounded batch of candidates, not only after the entire document. The default browser scheduler uses `requestIdleCallback` when present and a zero-delay `setTimeout` fallback; cancellation must cancel the scheduled callback and set a terminal flag.

- [ ] **Step 4: Run count and navigation tests**

Run:

```bash
pnpm --filter @omd/desktop exec vitest run test/searchCountJob.test.ts test/currentDocumentSearch.test.ts
```

Expected: PASS; navigation tests do not await count.

- [ ] **Step 5: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/src/searchCountJob.ts apps/desktop/test/searchCountJob.test.ts`

Expected: O(1) match storage and an explicit cancellation path.

### Task 4: Active Match and Replacement Parity

**Files:**
- Modify: `apps/desktop/src/currentDocumentSearch.ts`
- Modify: `apps/desktop/test/currentDocumentSearch.test.ts`

**Interfaces:**
- Produces:

```ts
export function replaceCurrentSpec(
  state: EditorState,
  request: SearchRequest,
  active: SearchMatch | null,
  replacement: string,
): TransactionSpec | null

export interface ReplaceAllResult {
  readonly changes: ChangeSet
  readonly replacements: number
  readonly revision: number
}

export function buildReplaceAll(
  doc: Text,
  request: SearchRequest,
  replacement: string,
): ReplaceAllResult | null
```

- [ ] **Step 1: Write parity tests with pending/truncated count**

Assert that replace-current uses the active range when valid, falls back deterministically to the next match when invalid, and remains correct while a count job has not published or has capped at 10,000. Test literal `$&` as literal text, regex `$1` capture expansion, invalid regex no-op, and exact replace-all output.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @omd/desktop exec vitest run test/currentDocumentSearch.test.ts`

Expected: replacement cases FAIL because the functions do not exist.

- [ ] **Step 3: Implement replace-current without count dependency**

Validate `active.revision`, range bounds, and candidate text against the live state. Return one transaction with the replacement and selection around inserted text. Literal replacement inserts the provided string unchanged.

- [ ] **Step 4: Implement exact replace-all independently of display count**

Run a fresh cursor to completion and build one `ChangeSet` for the captured revision. Do not call the display counter and do not stop at 10,000. For regex captures, use the cursor's match groups to expand `$1` semantics exactly as the current implementation. Reject zero-length matches.

The spike may retain `ChangeSpec[]` because atomic replace-all necessarily has O(replacement count) changes, but it must not retain a parallel `SearchMatch[]` or full document string. Record peak memory separately in the benchmark.

- [ ] **Step 5: Run semantic parity tests**

Run:

```bash
pnpm --filter @omd/desktop exec vitest run test/currentDocumentSearch.test.ts test/findReplace.test.ts
```

Expected: PASS for literal/regex replacement and invalid-pattern behavior.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/src/currentDocumentSearch.ts apps/desktop/test/currentDocumentSearch.test.ts`

Expected: count cap is absent from replacement code.

### Task 5: Disposable Regex Worker Proof

**Files:**
- Create: `apps/desktop/src/searchRegex.worker.ts`
- Modify: `apps/desktop/e2e/harness.ts`
- Create: `apps/desktop/e2e/search-worker-spike.spec.ts`

**Interfaces:**
- Produces worker messages:

```ts
type RegexWorkerRequest = {
  readonly id: number
  readonly revision: number
  readonly source: string
  readonly flags: string
  readonly text: string
}

type RegexWorkerResponse =
  | { readonly id: number; readonly revision: number; readonly match: { from: number; to: number } | null }
  | { readonly id: number; readonly revision: number; readonly error: string }
```

- [ ] **Step 1: Implement the worker with no editor imports**

Compile the regex inside the worker, skip zero-length matches, and post either the first match or a syntax error. The worker never receives an `EditorView` or mutates application state.

- [ ] **Step 2: Expose an opt-in harness helper**

Under `?searchSpike=1`, expose a function that starts a Worker, tags the request with revision/id, and returns handles for `terminate()` and result observation. Keep the normal harness unchanged.

- [ ] **Step 3: Write real Chromium worker tests**

Test:

- invalid regex returns a structured error;
- a normal regex returns correct UTF-16 offsets;
- a deliberately catastrophic regex begins in the worker, the main editor remains responsive to a selection transaction, and `terminate()` ends the worker;
- a response with an old revision is ignored.

- [ ] **Step 4: Run focused E2E**

Run:

```bash
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- search-worker-spike.spec.ts
```

Expected: PASS; the pathological case is terminated by the test timeout path, not allowed to finish on the main thread.

- [ ] **Step 5: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/src/searchRegex.worker.ts apps/desktop/e2e/harness.ts apps/desktop/e2e/search-worker-spike.spec.ts`

Expected: Worker use is harness-only; no persistent document mirror is introduced.

### Task 6: 100 MiB Benchmark and Chromium Heap Evidence

**Files:**
- Create: `apps/desktop/bench/search.bench.ts`
- Create: `apps/desktop/e2e/search-100m-audit.mjs`
- Modify: `apps/desktop/e2e/harness.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: Tasks 1–4 APIs.
- Produces: JSON-compatible measurements for fixture construction, next-hit latency, previous-hit latency/window expansion, count latency/slices, cancellation, heap, long-line offsets, and sparse replace-all.

- [ ] **Step 1: Add the spike benchmark command**

Add:

```json
"bench:search-spike": "vitest bench --run bench/search.bench.ts --reporter=verbose",
"audit:search-spike": "node e2e/search-100m-audit.mjs"
```

- [ ] **Step 2: Measure navigation separately from construction**

Construct each fixture before starting timers. Warm each operation five times, then record at least 30 next-navigation samples for start, middle, end, and wrap. Separately record at least 30 previous-navigation samples with the anchor near the 100 MiB tail and the nearest hit inside the initial 256 KiB window; report p50, p95, peak, number of cursor windows, and the earliest searched offset.

For the `normal-100m` gate, choose anchors whose next hit is within 1 MiB and require p95 ≤ 100 ms.

Keep that numeric acceptance gate scoped exactly as the spec defines it; previous-navigation measurements are feasibility evidence for the expanding-window design, not a new absolute gate in this spike.

- [ ] **Step 3: Measure count slices and cancellation**

Instrument scheduler callback start/end times. Require worst warmed slice ≤ 12 ms, verify query cancellation occurs before stale publish, and verify dense count stops at 10,000.

- [ ] **Step 4: Measure replacement without using display count**

Run exact sparse replace-all on `normal-100m`, record replacement count and elapsed time, and confirm the original `Text` remains unchanged until the result is dispatched to a state. Do not claim Vitest/happy-dom heap values as acceptance evidence.

- [ ] **Step 5: Implement the Chromium/CDP audit**

Under `?searchSpike=1`, expose harness functions that build one target fixture, run literal navigation/count, and release references. The Node audit opens a fresh Chromium page for baseline and dense-count measurement, forces GC through CDP, and records `Runtime.getHeapUsage` before construction, after construction, after count, after cancellation, and after release.

Require dense-count heap growth over the post-construction baseline to remain below 32 MiB. The timed search path must report counters proving zero full-document stringify calls and zero retained match arrays.

- [ ] **Step 6: Run the benchmark and audit**

Run:

```bash
pnpm --filter @omd/desktop bench:search-spike
PW_PORT=9436 pnpm --filter @omd/desktop audit:search-spike
```

Expected: all fixture rows print; Chromium JSON contains construction/search/GC samples; failures are preserved as evidence rather than hidden by reruns.

- [ ] **Step 7: Review the benchmark diff**

Run: `git diff --check && git diff -- apps/desktop/bench/search.bench.ts apps/desktop/e2e/search-100m-audit.mjs apps/desktop/e2e/harness.ts apps/desktop/package.json`

Expected: no generated 100 MiB files; no benchmark path calls full-document stringify.

### Task 7: Full Verification and Decision Report

**Files:**
- Create: `docs/superpowers/plans/2026-10-28-search-100m-spike-results.md`

**Interfaces:**
- Consumes: unit/E2E/benchmark outputs.
- Produces: one reviewed `Go`, `Revise`, or `Stop` decision.

- [ ] **Step 1: Run complete desktop verification**

Run:

```bash
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- search-worker-spike.spec.ts
pnpm --filter @omd/desktop bench:search-spike
PW_PORT=9436 pnpm --filter @omd/desktop audit:search-spike
```

Expected: correctness/build/E2E PASS; benchmark prints all required metrics.

- [ ] **Step 2: Create the result report**

```markdown
# 100 MiB Search Spike Results

## Environment and Commit
## Commands
## Fixture Construction
## Navigation Latency
## Count Slicing and Cancellation
## Semantic Parity
## Replace-All Evidence
## Regex Worker Evidence
## Heap Evidence
## Failed Cases
## Decision
## Production Recommendation
## Prototype Files: Keep, Rewrite, Delete
```

- [ ] **Step 3: Apply the decision gate**

- `Go`: literal/whole-word navigation, count, cancellation, long-line offsets, semantic parity, Worker termination, and bounded heap gates pass.
- `Revise`: literal kernel passes but regex isolation, replace-all, or scheduling requires a smaller follow-up; recommend literal-first migration and keep large-document regex disabled.
- `Stop`: target-size literal navigation requires full string materialization or retained match arrays.

- [ ] **Step 4: State migration limits explicitly**

Even on `Go`, state that `App.tsx`, `FindReplaceBar`, and production `findReplace.ts` remain unchanged. Name the required follow-up design for React lifecycle, user-visible truncated count, and any large-document replace-all restriction.

- [ ] **Step 5: Final plan checkpoint**

Run: `git status --short && rg -n "^## |^### " docs/superpowers/plans/2026-10-28-search-100m-spike-results.md`

Expected: every report heading populated; no unrelated files modified.
