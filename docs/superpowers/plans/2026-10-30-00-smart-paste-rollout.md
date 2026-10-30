# Smart Paste Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Typora-style semantic rich-text paste without blocking the common path on rare complex tables or unverified native clipboard work.

**Architecture:** The rollout is split into four independently reviewable plans. Run the host capability preflight early, independently of the semantic baseline; then land the pure engine importer and desktop cutover. Complex rowspan/colspan tables remain an optional post-cutover track. Each completed track has an explicit stop/go gate; intermediate task commits are not release approval.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, DOMParser, Vitest, Playwright, Tauri 2/Rust only where asset persistence requires it.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Lezer remains the only parser for persisted Markdown source.
- Live Preview hides or projects syntax; it never rewrites source.
- Normal Paste imports HTML semantics; Paste as Plain Text inserts `text/plain` exactly.
- External color, background, font size, font family, class, `data-*`, and presentation-only `span` never enter Markdown.
- No Paste AST node IDs, output source map, heterogeneous-tree diff, node-level downgrade, or parse retry.
- One paste performs at most one new bounded Markdown parse.
- Validate the final boundary-planned insertion, never a fragment that is modified after validation.
- Normal and explicit plain-text paste share asynchronous target protection; only their payload and literal-encoding policies differ.
- Asset jobs revalidate the captured document path as well as tab/document/view identity; never guess HTML-image/File correspondence from array order.
- Raw clipboard HTML never reaches `innerHTML`.
- No production path forces the editor syntax tree to `doc.length`.
- Platform branches live only in `apps/desktop/src/platform.ts` or Rust `cfg!(target_os = …)`.
- Every `block: true` widget must satisfy selection rebuild, estimated height, block entry, covered overlay, and shared `BlockWidget` lifecycle contracts.

## Plan Set and Dependencies

```text
1. Semantic baseline ────────────────► 2. Core importer ──► 3. Host cutover
03 Task 1: capability preflight ─────►          │                  │
                                              └──────────────────┴──► 4. Complex table (optional)
```

Run Plan 03 Task 1 before committing to the importer replacement, without waiting for Plans 01/02. A failed platform blocks importer-replacement approval and host cutover until a narrow adapter is designed and verified; it does not block shipping the independent Plan 01 projection fixes. Plan 04 requires completed Plans 01–03 and an explicit product priority for merged tables.

1. [Semantic baseline](./2026-10-30-01-smart-paste-semantic-baseline.md)
   fixes Link/Image semantics, Escape, HardBreak, and rich table-cell export before paste behavior changes.
2. [Core importer](./2026-10-30-02-smart-paste-core-importer.md)
   introduces the small Paste AST, semantic normalizer, serializer, one-parse guard, and strict fallback as pure engine APIs.
3. [Host cutover](./2026-10-30-03-smart-paste-host-cutover.md)
   unifies DOM/system clipboard entry points, mapped targets, images, shortcuts, and deletes Turndown.
4. [Complex table](./2026-10-30-04-smart-paste-complex-table.md)
   adds canonical rowspan/colspan HTML and its block widget. This plan is an optional post-cutover milestone: execute Plans 1 → 2 → 3 and verify real-platform stability first; do not start Plan 4 unless complex-table preservation is explicitly prioritized over the safe visible-text fallback.

Phase 6 ordered-list source projection from the spec is deliberately excluded. It is an independent source-preservation project and must receive its own plan after Smart Paste is stable.

## Decisions for Review

- Accept one bounded parse as a circuit breaker, followed by whole-fragment strict serialization without a retry.
- Choose the plain or structured candidate before that parse; a failed plain candidate goes directly to strict literal output, not a second structured validation.
- Ship common rich-text paste independently of rowspan/colspan widgets; merged tables use visible-text fallback plus one notice until Plan 4 lands.
- Require real WKWebView/WebView2/WebKitGTK clipboard evidence before deleting the old pipeline; a failed platform returns to design for a narrow native adapter.
- Persist embedded images through opaque Rust-owned batch IDs with explicit commit/discard, never through caller-selected cleanup paths.
- Put `Mod+Shift+v` in `EDIT_SHORTCUT_BINDINGS` (and `crossLayerMenu.test.ts`), the native macOS menu accelerator (`CmdOrCtrl+Shift+V`), and the editor CodeMirror keymap (`Mod-Shift-v` for Windows/Linux), never the global window keydown dispatcher.
- Respect legacy module-size caps (`scripts/module-size-baseline.json`) on `Editor.test.ts`, `menu.rs`, `App.tsx`, `App.test.tsx`, and `lib.rs`: new paste/bookmark tests go into dedicated test files, and frozen files may only shrink or replace lines in place.
- Keep ordered-list source-number projection out of this rollout because it is not required to make imported content semantically correct.

## Review and Merge Gates

### Gate A: Semantic baseline

- [x] Preview, cell parsing, sync export, and rich export agree on Link/Image destination, title, label/alt, and table-cell semantics.
- [x] Escape and both HardBreak forms are correct in Preview, sync export, rich export, and table cells.
- [x] GFM escaped pipes inside code spans remain correct; table Preview and both exporters consume the same raw-source cell contract, reference resolver, and title fields.
- [x] Editing a reference definition refreshes dependent visible projections; ordinary edits do not rebuild a whole-document reference map.
- [x] `pnpm test`, desktop build, and focused E2E pass.

### Gate B: Pure importer

- [x] `access_token` remains unescaped while literal `# title`, `$x$`, and `**x**` are protected in HTML-text paste.
- [x] Style-noise fixtures do not emit color/background/font-size/span HTML.
- [x] Tests prove one parse maximum and whole-fragment strict fallback.
- [x] The parsed candidate is byte-identical to the dispatched insertion, including block separators; strict fallback and boundary planning have host-context regression cases.
- [x] No DOM paste handler changes yet; old production behavior remains active.

### Gate C: Common Smart Paste cutover

- [x] Keyboard, native menu, app menu, command palette, and context menu share the same controller.
- [x] `Cmd/Ctrl+Shift+V` is exact plain-text paste with no double dispatch.
- [x] Both paste commands reject readOnly/stale/destroyed targets and preserve mapped multi-range behavior; Save As/rename during asset IO cancels and cleans up the old-path batch.
- [x] Ambiguous rich-HTML/File associations preserve alt rather than substituting an unrelated image.
- [x] macOS right-click target repair preserves rich HTML.
- [x] Clipboard API capability evidence exists for WKWebView, WebView2, and WebKitGTK. A failing platform stops this gate and gets a separate narrow native-adapter plan.
- [x] Turndown and the competing engine DOM handler are deleted only after E2E and manual QA pass.
- [x] Existing heading/list/link/code/simple-table behavior has explicit old/new regression fixtures, including code-span pipes; intentional changes are named rather than silently accepted.

Until the complex-table plan lands, rowspan/colspan input follows the already-specified safe fallback: preserve visible cell text, report one non-modal fidelity downgrade, and never save arbitrary source HTML.

### Gate D: Complex tables

- [x] Canonical tables contain no blank physical line; final insertion at supported host positions has blank-line isolation, one complete `HTMLBlock`, intact surrounding content, and a caret outside the widget range.
- [x] Header `scope` and resolved image assets survive normalization, serialization, Preview, and export.
- [x] Broken/edited HTML fails closed to visible source; no sibling-node stitching exists.
- [x] Widget selection, height, navigation, overlay, source entry, export, and accessibility gates pass.

## Final Verification

Run after all accepted tracks:

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm check:quality
PW_PORT=9480 pnpm --filter @omd/desktop test:e2e
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

`pnpm verify` is the release gate after the platform-capability/manual matrix has been completed on each supported host.
