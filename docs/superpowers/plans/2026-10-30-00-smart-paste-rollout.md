# Smart Paste Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Typora-style semantic rich-text paste without blocking the common path on rare complex tables or unverified native clipboard work.

**Architecture:** The rollout is split into four independently reviewable plans. Semantic projection defects are fixed first, the pure engine importer lands second, desktop clipboard ownership and cutover land third, and complex rowspan/colspan tables remain an additive fourth track. Each track ends in releasable software and has an explicit stop/go gate.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, DOMParser, Vitest, Playwright, Tauri 2/Rust only where asset persistence requires it.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Lezer remains the only parser for persisted Markdown source.
- Live Preview hides or projects syntax; it never rewrites source.
- Normal Paste imports HTML semantics; Paste as Plain Text inserts `text/plain` exactly.
- External color, background, font size, font family, class, `data-*`, and presentation-only `span` never enter Markdown.
- No Paste AST node IDs, output source map, heterogeneous-tree diff, node-level downgrade, or parse retry.
- One paste performs at most one new bounded Markdown parse.
- Raw clipboard HTML never reaches `innerHTML`.
- No production path forces the editor syntax tree to `doc.length`.
- Platform branches live only in `apps/desktop/src/platform.ts` or Rust `cfg!(target_os = …)`.
- Every `block: true` widget must satisfy selection rebuild, estimated height, block entry, covered overlay, and shared `BlockWidget` lifecycle contracts.

## Plan Set and Dependencies

```text
1. Semantic baseline ───────► 2. Core importer ───────► 3. Host cutover
                                      │
                                      └───────────────► 4. Complex table (optional additive track)
```

1. [Semantic baseline](./2026-10-30-01-smart-paste-semantic-baseline.md)
   fixes Link/Image semantics, Escape, HardBreak, and rich table-cell export before paste behavior changes.
2. [Core importer](./2026-10-30-02-smart-paste-core-importer.md)
   introduces the small Paste AST, semantic normalizer, serializer, one-parse guard, and strict fallback as pure engine APIs.
3. [Host cutover](./2026-10-30-03-smart-paste-host-cutover.md)
   unifies DOM/system clipboard entry points, mapped targets, images, shortcuts, and deletes Turndown.
4. [Complex table](./2026-10-30-04-smart-paste-complex-table.md)
   adds canonical rowspan/colspan HTML and its block widget. This plan is additive and does not block the common importer cutover.

Phase 6 ordered-list source projection from the spec is deliberately excluded. It is an independent source-preservation project and must receive its own plan after Smart Paste is stable.

## Decisions for Review

- Accept one bounded parse as a circuit breaker, followed by whole-fragment strict serialization without a retry.
- Ship common rich-text paste independently of rowspan/colspan widgets; merged tables use visible-text fallback plus one notice until Plan 4 lands.
- Require real WKWebView/WebView2/WebKitGTK clipboard evidence before deleting the old pipeline; a failed platform returns to design for a narrow native adapter.
- Persist embedded images through opaque Rust-owned batch IDs with explicit commit/discard, never through caller-selected cleanup paths.
- Put `Mod+Shift+V` in the edit-command display/drift map and native/editor paste path, not the global window keydown dispatcher.
- Keep ordered-list source-number projection out of this rollout because it is not required to make imported content semantically correct.

## Review and Merge Gates

### Gate A: Semantic baseline

- [ ] Preview, cell parsing, sync export, and rich export agree on Link/Image destination, title, label/alt, and table-cell semantics.
- [ ] Escape and both HardBreak forms are correct in Preview, sync export, rich export, and table cells.
- [ ] `pnpm test`, desktop build, and focused E2E pass.

### Gate B: Pure importer

- [ ] `access_token` remains unescaped while literal `# title`, `$x$`, and `**x**` are protected in HTML-text paste.
- [ ] Style-noise fixtures do not emit color/background/font-size/span HTML.
- [ ] Tests prove one parse maximum and whole-fragment strict fallback.
- [ ] No DOM paste handler changes yet; old production behavior remains active.

### Gate C: Common Smart Paste cutover

- [ ] Keyboard, native menu, app menu, command palette, and context menu share the same controller.
- [ ] `Cmd/Ctrl+Shift+V` is exact plain-text paste with no double dispatch.
- [ ] macOS right-click target repair preserves rich HTML.
- [ ] Clipboard API capability evidence exists for WKWebView, WebView2, and WebKitGTK. A failing platform stops this gate and gets a separate narrow native-adapter plan.
- [ ] Turndown and the competing engine DOM handler are deleted only after E2E and manual QA pass.

Until the complex-table plan lands, rowspan/colspan input follows the already-specified safe fallback: preserve visible cell text, report one non-modal fidelity downgrade, and never save arbitrary source HTML.

### Gate D: Complex tables

- [ ] Canonical tables contain no blank physical line and parse as one `HTMLBlock`.
- [ ] Broken/edited HTML fails closed to visible source; no sibling-node stitching exists.
- [ ] Widget selection, height, navigation, overlay, source entry, export, and accessibility gates pass.

## Final Verification

Run after all accepted tracks:

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9480 pnpm --filter @omd/desktop test:e2e
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

`pnpm verify` is the release gate after the platform-capability/manual matrix has been completed on each supported host.
