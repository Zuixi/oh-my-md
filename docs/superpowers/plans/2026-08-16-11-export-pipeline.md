# 11 Export Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export HTML/PDF/PNG with KaTeX, Shiki, and Mermaid matching preview; wait for `__omdExportReady`.

**Architecture:** Add async `exportRichHtml` beside sync `exportHtml`. Desktop export awaits rich HTML. Rust export_preview polls `window.__omdExportReady` up to 5s.

**Tech Stack:** TypeScript, KaTeX, Shiki, Mermaid, WKWebView, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-16-11-export-pipeline-design.md`

## Global Constraints

- Keep `exportHtml` for existing snapshot tests unless they are updated intentionally.
- Math/Mermaid failures stay as escaped source, never throw out of export.
- Do not screenshot the live editor.
- Do not inline remote http images.
- Engine stays React/Tauri-free.
- `pnpm test`, desktop tests, and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` when Rust changes.

---

### Task 1: exportRichHtml

**Files:**
- Modify: `packages/engine/src/export/html.ts`
- Create: `packages/engine/test/export-rich.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- `exportRichHtml(state, options?): Promise<string>`

- [ ] **Step 1: Test `$a$` rich HTML is not a bare `<code>$a$</code>`; js fence highlighted; bad mermaid contains source; `__omdExportReady` present**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Reuse widget KaTeX/Shiki/Mermaid helpers; wrap document**
- [ ] **Step 4: `pnpm test`**
- [ ] **Step 5: Commit** `feat: export HTML with math code and diagrams`

---

### Task 2: desktop + WKWebView wait

**Files:**
- Modify: `apps/desktop/src/appExportActions.ts`
- Modify: `apps/desktop/test` export tests if any
- Modify: `apps/desktop/src-tauri/src/export.rs` / `export_native.rs`

- [ ] **Step 1: Test exportCurrent awaits exportRichHtml**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Wire rich export; poll `__omdExportReady` max 5s**
- [ ] **Step 4: desktop + cargo tests**
- [ ] **Step 5: Commit** `feat: wait for export render before PDF capture`

Update `docs/manual-qa.md`.
