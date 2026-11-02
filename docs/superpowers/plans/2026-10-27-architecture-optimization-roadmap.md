# Architecture Optimization Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the few evidence-backed architecture risks in OMD without rewriting stable subsystems or introducing speculative abstractions.

**Architecture:** Execute five independent plans. Each plan first establishes an enforceable contract or measurement, then makes only the smallest change justified by that evidence. Runtime behavior is changed only where a correctness boundary is already violated or a benchmark demonstrates a user-visible budget miss.

**Tech Stack:** TypeScript, React 19, CodeMirror 6, Vitest, Playwright/Chromium CDP, Tauri 2, Rust.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- Preserve the engine / desktop / Rust ownership boundaries in the root and domain `AGENTS.md` files.
- Do not add Redux, Zustand, Turborepo, Nx, or a new benchmark/test framework.
- Do not rewrite guarded save, conflict handling, progressive decoration seeding, or the Tauri updater.
- Do not force full syntax parsing in production.
- Every runtime optimization must have a failing regression test or a benchmark demonstrating the current cost.
- Every plan is independently mergeable; do not combine them into one branch or one commit series.

---

## Decision Matrix

| Concern | Decision | Reason | Rejected alternative |
|---|---|---|---|
| Legacy normalization saver in `normalizationCoordinator.ts` | Remove dead duplicate implementation | Production already uses `documentSaveRunner`, which correctly captures normalization and calls guarded `saveDocument`; retaining the duplicate advertises an unsafe path and invites reuse | Rewire the dead saver to `saveDocument`: unnecessary because there is no consumer |
| Widget churn memory growth | Investigate in a real browser before changing ownership APIs | Existing 1.8 GB measurement is real in Node/happy-dom but the retaining object is unknown; abstraction before a dominator trace may preserve the leak | Add `DisposerBag` immediately: speculative and may target the wrong owner |
| Unbounded math export cache | Reuse `BoundedLru` with explicit entry and byte limits | The growth mechanism is confirmed and the repository already has the required primitive | Clear after every export: removes useful cross-export reuse; add a new cache package: duplication |
| Live-preview typing cost | Fix benchmark coverage first | Current synchronous benchmark does not drain production non-safe-mode pending decorations, so it cannot justify pipeline changes | Enable always-on windowing immediately: changes semantics without baseline data |
| `documentStats` cost | Optimize only after preserving exact count semantics in tests and benchmark | The implementation performs a Unicode regex test per character and already has a dedicated benchmark | Build incremental stats StateField: significantly more state and invalidation complexity than needed |
| Multi-view widget registry | Add a two-view correctness contract first | Cross-view binding is plausible because registries are module-global, but no failing case is recorded | Move immediately to per-view registries: unnecessary migration if identity/DOM validation already prevents the bug |
| Paste ownership | Add full-editor ordering tests first | Current routing depends on extension order, but the smallest protection is an executable ownership contract | Build a generic paste framework: one more abstraction before a second confirmed routing failure |
| `App.tsx` size | Freeze new responsibilities; extract only while modifying a cluster | File length alone is not a behavior defect; arbitrary line budgets encourage code shuffling | Big-bang decomposition or a state library: high risk and no direct user benefit |

## Execution Order

1. [`2026-10-27-normalization-save-ownership.md`](./2026-10-27-normalization-save-ownership.md)
2. [`2026-10-27-bounded-math-export-cache.md`](./2026-10-27-bounded-math-export-cache.md)
3. [`2026-10-27-widget-memory-investigation.md`](./2026-10-27-widget-memory-investigation.md)
4. [`2026-10-27-live-performance-evidence.md`](./2026-10-27-live-performance-evidence.md)
5. [`2026-10-27-editor-ownership-contracts.md`](./2026-10-27-editor-ownership-contracts.md)

The order is deliberate:

- Save ownership is a small correctness cleanup with no behavioral redesign.
- The confirmed unbounded cache has a low-risk fix using an existing primitive.
- Memory investigation comes before a lifecycle abstraction because the root retainer is unknown.
- Performance measurement comes before decoration optimization because the current benchmark is structurally incomplete.
- Cross-view and paste contracts are preventive guards; they should not delay correctness or performance work.

## Explicitly Deferred

- **`App.tsx` decomposition:** begin only when a feature must modify one of the existing ref/state clusters. Extract that cluster and its tests in the same change; do not create a standalone “reduce line count” project.
- **Always-on live windowing:** write a separate design and implementation plan only if the full-drain benchmarks in the performance plan exceed the decision thresholds.
- **`BlockWidget.own(disposer)`:** write a follow-up implementation plan only if browser heap dominators show two or more widget subclasses retaining resources through missing cleanup.
- **Rust `lib.rs` splitting:** move commands opportunistically when their behavior changes; do not perform a mechanical module shuffle.
