# Widget Memory Investigation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether block-widget churn leaks in a real browser, identify the retaining object, and produce evidence for the smallest correct fix.

**Architecture:** Keep investigation tooling outside the normal CI suite until a deterministic production-browser leak is established. Use the real desktop E2E harness plus Chromium DevTools Protocol garbage collection and heap snapshots; compare it with the existing happy-dom reproduction.

**Tech Stack:** Playwright Chromium, Chrome DevTools Protocol `HeapProfiler`, CodeMirror 6, existing Vite E2E harness.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- Do not add a lifecycle abstraction before identifying a production retainer.
- Do not use process load generation or unbounded churn loops.
- Use fixed rounds of 100/500/1000 state flips with explicit GC between rounds.
- The investigation script is manual tooling, not a flaky CI gate.
- Update the existing “块 widget 反复挂载/卸载” gotcha with browser evidence.

---

### Task 1: Add a real-browser churn audit

**Files:**
- Create: `apps/desktop/e2e/widget-memory-audit.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `docs/memory/gotchas-engine.md`

**Interfaces:**
- Consumes: `window.__view` from `apps/desktop/e2e/harness.ts`.
- Produces: JSON containing `usedSize` after baseline, 100, 500, 1000 flips, and after `view.destroy()`.

- [ ] **Step 1: Add the audit script**

Implement a bounded script following `calibrate-heights.mjs`:

```js
import { chromium } from "@playwright/test"

const DOC = [
  "> | a | b |",
  "> |---|---|",
  ...Array.from({ length: 20 }, (_, i) => `> | ${i} | ${i + 1} |`),
  "",
  "tail",
].join("\n")

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
await page.goto(`http://localhost:9420/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
await page.waitForSelector(".omd-table")
const cdp = await page.context().newCDPSession(page)
await cdp.send("HeapProfiler.enable")

async function collect(label) {
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(50)
  const usage = await cdp.send("Runtime.getHeapUsage")
  return { label, usedSize: usage.usedSize, totalSize: usage.totalSize }
}

async function flip(count) {
  await page.evaluate(iterations => {
    const view = window.__view
    const end = view.state.doc.length
    for (let i = 0; i < iterations; i++) {
      view.dispatch({ selection: { anchor: i % 2 === 0 ? end : 0 } })
    }
  }, count)
  await page.waitForTimeout(100)
}
```

Collect at baseline, cumulative 100/500/1000 flips, then call `window.__view.destroy()` and collect once more. Print one JSON object and close the browser.

- [ ] **Step 2: Add an explicit manual command**

Add to `apps/desktop/package.json`:

```json
"audit:widget-memory": "node e2e/widget-memory-audit.mjs"
```

Do not include it in `test:e2e`.

- [ ] **Step 3: Run the audit**

Terminal A:

```bash
pnpm --filter @omd/desktop dev --port 9420 --strictPort
```

Terminal B:

```bash
pnpm --filter @omd/desktop audit:widget-memory
```

Expected output: bounded JSON with five samples; no claim is made yet about pass/fail.

- [ ] **Step 4: Record the evidence**

Append the exact Chromium version, platform, sample values, and one of these classifications to `docs/memory/gotchas-engine.md`:

- `production-browser reproduced`: used heap grows monotonically across both 500-flip windows and remains above 75% of peak after destroy;
- `happy-dom only`: heap returns within 20% of the post-100-flip level after destroy;
- `inconclusive`: neither condition holds.

- [ ] **Step 5: Commit the diagnostic tooling**

```bash
git add apps/desktop/e2e/widget-memory-audit.mjs \
  apps/desktop/package.json docs/memory/gotchas-engine.md
git commit -m "test: measure block widget churn in a real browser"
```

### Task 2: Capture and classify retained objects

**Files:**
- Modify: `apps/desktop/e2e/widget-memory-audit.mjs`
- Modify: `docs/memory/gotchas-engine.md`

**Interfaces:**
- Produces: two `.heapsnapshot` files outside the repository and a ranked retainer summary in the gotcha.

- [ ] **Step 1: Stream heap snapshots before and after churn**

Before each snapshot, subscribe to `HeapProfiler.addHeapSnapshotChunk`, then call:

```js
await cdp.send("HeapProfiler.takeHeapSnapshot", {
  reportProgress: true,
  captureNumericValue: true,
})
```

Append each event's `chunk` to the current snapshot buffer. After the command resolves and the final progress event has been received, write the assembled buffer to:

```text
/tmp/omd-widget-baseline.heapsnapshot
/tmp/omd-widget-after-1000.heapsnapshot
```

Remove each chunk listener before starting the next snapshot so chunks cannot cross-contaminate files. Keep these files out of the repository. The script must remove existing files at those exact paths before writing and must close file handles before browser shutdown.

- [ ] **Step 2: Compare dominators**

Open both snapshots in Chrome DevTools Memory and rank retained-size growth for:

```text
EditorView
ResizeObserver
HTMLTableCellElement
HTMLButtonElement
Function / EventListener
BlockWidget subclasses
```

For the largest growing constructor, follow the retaining path to the first OMD-owned object/module.

- [ ] **Step 3: Isolate one suspect at a time**

Use temporary local-only probes, never committed together:

1. disable math popup creation;
2. disable code language picker document listener;
3. disable table cell hover listeners;
4. disable `blockSelectionOverlay` registration.

Run the same 1000-flip audit after each probe. The suspect is accepted only when the retained growth drops by at least 80% in two consecutive runs.

- [ ] **Step 4: Write the implementation decision**

Update the gotcha with one exact conclusion:

- one missing cleanup owner → plan a surgical cleanup in that module;
- two or more widget subclasses missing cleanup → plan `BlockWidget.own(disposer)`;
- no OMD-owned retainer → file the exact CodeMirror/happy-dom upstream reproduction and do not add an OMD abstraction.

- [ ] **Step 5: Commit only durable evidence**

Revert all temporary probes. Commit only the audit script and documentation:

```bash
git add apps/desktop/e2e/widget-memory-audit.mjs docs/memory/gotchas-engine.md
git commit -m "docs: identify block widget memory retainer"
```

## Why This Plan, Not the Alternatives

- **Why Chromium before `DisposerBag`:** the existing measurement may be caused by happy-dom or CodeMirror tile retention; a cleanup framework cannot fix an external retainer.
- **Why manual audit rather than CI heap threshold:** heap sizes vary across Chrome versions and runners. CI should receive a deterministic regression only after the retaining object is known.
- **Why bounded flips:** the repository forbids load-generation scripts, and 1000 flips already gives a large signal without saturating the machine.
- **Why one suspect per run:** disabling multiple resources cannot identify ownership and produces a non-actionable “something helped” result.
