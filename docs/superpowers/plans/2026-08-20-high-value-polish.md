# High-Value Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four high-perception, low-risk daily-writing features for oh-my-md: (1) paste-as-plain-text command, (2) subscript/superscript inline syntax plus `\(\)`/`\[\]` math delimiters, (3) self-contained export HTML with shared typography CSS + user custom-CSS injection, (4) a warning when exporting PDF/PNG that contain remote (non-embeddable) images.

**Architecture:** Each feature is implemented and verified in its own isolated git worktree/branch (see `using-git-worktrees`). Engine changes live only in `packages/engine` (framework-independent; no React/Tauri imports). Desktop glue lives only in `apps/desktop/src`. No Rust changes are required for any of these four features.

**Tech Stack:** CodeMirror 6 + Lezer Markdown (engine); React 19 + Tauri 2 (desktop); Vitest + happy-dom (tests).

**Spec:** Derived from `docs/superpowers/specs/2026-08-19-industry-self-assessment.md` §9.3 (export CSS / custom CSS / remote-image warning), §9.5 (paste-plain-text, sub/superscript, math delimiters). This plan is the implementation authority; the spec is the rationale.

## Global Constraints

- Write strict TypeScript; **avoid `any`**; use **named exports** (config files may use default).
- **Engine must not import React or Tauri.** It may use browser DOM APIs for widgets. Tests provide `happy-dom`.
- Do **not** re-implement Markdown syntax detection already owned by the engine in desktop or Rust.
- Do **not** enable `indentOnInput`, `closeBrackets`, or generic `autocompletion` in `createEditor` (desktop).
- **Do not** trigger a complete-document parse (`forceParsing`/`ensureSyntaxTree` to `doc.length`) in engine code — see `docs/memory/known-gotchas.md` complete-tree trap. Decorations/widgets must stay incremental.
- Shared/cross-layer limits and storage keys live in `apps/desktop/src/constants.ts`; ASCII punctuation in engine parsers uses named constants in `packages/engine/src/parse/chars.ts`.
- User-facing strings go through the i18n store: desktop components use `useT()`; non-component modules use the module-level `t` (reads live locale). **zh and en message keys must be added in pairs** in `apps/desktop/src/i18n/messages/{zh,en}.ts`.
- Commit messages follow `<type>: <why>` (feat/fix/refactor/docs/test/chore/perf/ci). The commit-msg hook requires this.
- Verification: engine `pnpm test` (runs `tsc --noEmit` then Vitest); desktop `pnpm --filter @omd/desktop test`.
- `packages/engine` is consumed directly from `src/index.ts`; there is **no separate package build step**.
- Preserve source text: preview/export are projections; do not silently rewrite user content.

---

## Feature A — Paste as plain text (`feat/paste-plain-text`)

**Why:** Users pasting from rich sources get unwanted formatting. A command that inserts the clipboard's plain text is a cheap, high-perception win.

**Files:**
- Create: `apps/desktop/src/pastePlainText.ts`
- Modify: `apps/desktop/src/App.tsx` (register command), `apps/desktop/src/commands.ts` (`MENU_TO_COMMAND`), `apps/desktop/test/crossLayerMenu.test.ts` (drift guard reads `menu.rs` + `menuTree.ts`, so also check `apps/desktop/src-tauri/src/menu.rs` and `apps/desktop/src/menuTree.ts` if a menu item is added)
- Test: `apps/desktop/test/App.test.tsx` (existing harness)

**Interfaces:**
- `pastePlainText(view: EditorView): Promise<void>` — reads `navigator.clipboard.readText()`, inserts at the current selection (replacing it) via a single `view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.paste", scrollIntoView: true })`; no-op if clipboard text is empty.
- Consumes: existing clipboard availability (same environment as image paste). Does **not** require a Tauri command.

**Tasks:**

- [ ] **Task A1: Add `pastePlainText` helper**
  - Create `apps/desktop/src/pastePlainText.ts` exporting `pastePlainText(view)`.
  - Guard `navigator.clipboard?.readText()`; on missing API or empty text, return without dispatching.
  - Insert replacing the main selection; `userEvent: "input.paste"`.
  - No `any`; import `EditorView` from `@codemirror/view`.

- [ ] **Task A2: Wire the command**
  - In `App.tsx`, add a command (follow the existing `bold`/`italic` command shape in the `commands` array near the formatting commands) with `id: "pastePlainText"`, a `t("cmd.label.pastePlainText")` label, optional `shortcutFor("pastePlainText")`, and `run: () => { const v = viewRef.current; if (v) void pastePlainText(v) }`.
  - Register the id in `commands.ts` `MENU_TO_COMMAND` if a menu entry is desired (check existing pattern; a palette-only command may omit menu mapping — but then `crossLayerMenu.test.ts` is unaffected). Prefer adding it to the Edit menu in `menu.rs` + `menuTree.ts` for parity with Typora, and add the label to i18n zh/en.
  - Add i18n keys `cmd.label.pastePlainText` to `apps/desktop/src/i18n/messages/{zh,en}.ts`.

- [ ] **Task A3: Test**
  - In `apps/desktop/test/App.test.tsx`, add a test that opens a doc, runs the `pastePlainText` command with `navigator.clipboard.readText` mocked to return `"**bold**"` (or similar), and asserts the editor doc gains that literal text (not a bold widget) at the cursor. Also assert no-op when clipboard is empty.
  - Run `pnpm --filter @omd/desktop test -- App.test.tsx` and confirm green.

- [ ] **Task A4: Commit**
  - `git add` the changed files; `git commit -m "feat: add paste-as-plain-text command"`.

---

## Feature B — Subscript/superscript + `\(\)`/`\[\]` math (`feat/inline-sub-sup-math`)

**Why:** Typora-parity inline syntax (`~x~` → subscript, `^x^` → superscript) and alternate math delimiters (`\(...\)` inline, `\[...\]` block) are small, high-perception editor wins.

**Files (engine):**
- Modify: `packages/engine/src/parse/math.ts` (add `\(`/`\[` inline + `\[...\]` block delimiters; keep `$`/`$$` working)
- Create/modify: `packages/engine/src/parse/subscript.ts` (new `MarkdownConfig` for `~x~`/`^x^`) — OR fold into a single new `packages/engine/src/parse/inlineMarks.ts`. Decide one file; name it `packages/engine/src/parse/rise.ts` if new.
- Modify: `packages/engine/src/index.ts` (register the new config in `editorExtensions` markdown config list)
- Modify: `packages/engine/src/decorations/inline.ts` (fold the new `Subscript`/`Superscript` nodes like `Emphasis`)
- Modify: `packages/engine/src/export/html.ts` (`exportHtml` + `exportRichHtml` render sub/sup; math render already covers `$`; extend to `\(\)`/`\[\]`)
- Test: `packages/engine/test/markdown.test.ts` (or a new `packages/engine/test/inlineMarks.test.ts`) + `packages/engine/test/export.test.ts`

**Interfaces:**
- New Lezer nodes: `Subscript`, `Superscript` (inline), each with a single delimiter mark pair (reuse a generic `RiseMark` or two marks). Export them from the new parse module.
- `editorExtensions` must include the new `MarkdownConfig` in the markdown language support (add to the array passed to `markdownLanguageSupport` / `MarkdownExtension`).
- Decorations: `foldPair(node, state, out, "RiseMark", "omd-sub")` / `"omd-sup"` — follow the exact `foldPair` pattern in `inline.ts`.
- Export: `Subscript` → `<sub>…</sub>`, `Superscript` → `<sup>…</sup>` in both `render` and `renderRich`.

**Tasks:**

- [ ] **Task B1: Sub/superscript parser**
  - Add a `MarkdownConfig` defining `Subscript`/`Superscript` inline nodes with delimiter marks (`~`/`^`). Parse must not be greedy across whitespace mismatches and must respect the existing delimiter rules (e.g. `^x^` with non-space boundaries, mirroring the `InlineMath` boundary checks in `parse/math.ts`).
  - Register the config in `editorExtensions` (engine `index.ts`).
  - Add engine test: `"H~2~O and x^2^"` yields `Subscript`/`Superscript` nodes with folded marks; `"~~x~~"` or lone `~` does not.

- [ ] **Task B2: Decorations**
  - In `inline.ts`, add `case "Subscript": return foldPair(node, state, out, "RiseMark", "omd-sub")` and `case "Superscript": ... "omd-sup"` (use the actual mark name chosen in B1).
  - Add an engine test asserting the marks are replaced and the `omd-sub`/`omd-sup` class is applied (use `makeState` + decoration inspection or a view-smoke assertion).

- [ ] **Task B3: Math alternate delimiters**
  - Extend `parse/math.ts`: add inline `\(...\)` and block `\[...\]` parsing alongside existing `$`/`$$`. Keep the `throwOnError`/fallback behavior identical. Ensure `InlineMath`/`MathBlock` nodes are produced for the new delimiters.
  - Extend `export/html.ts` `render`/`renderRich` so the math content extraction strips `\(`/`\)`/`\[`/`\]` as it already strips `$`.

- [ ] **Task B4: Export sub/sup**
  - In `export/html.ts`, render `Subscript` → `<sub>` and `Superscript` → `<sup>` in both `render` (sync) and `renderRich`.
  - Add engine export test asserting `<sub>`/`<sup>` output and that `\(x\)`/`\[x\]` math survives round-trip through `exportHtml`/`exportRichHtml`.

- [ ] **Task B5: Commit**
  - `git add` engine files + tests; `git commit -m "feat: subscript/superscript syntax and \\(\\)/\\[\\] math delimiters"`.

---

## Feature C — Self-contained export HTML + custom CSS (`feat/export-html-css`)

**Why:** Exported HTML currently has almost no typography and ignores the user's custom CSS, so exports look broken vs the editor. A shared, inline stylesheet plus optional custom-CSS injection makes exports presentable and consistent.

**Files (engine + desktop):**
- Create: `packages/engine/src/export/styles.ts` exporting `EXPORT_BODY_CSS: string` (a TS string constant — engine has no CSS bundler step; do **not** `import "./x.css"`).
- Modify: `packages/engine/src/export/html.ts` — `ExportRichHtmlOptions` gains `customCss?: string`; `exportRichHtml` inlines `<style>${EXPORT_BODY_CSS}</style>` plus `<style>${customCss}</style>` when provided; also apply the same base CSS to `exportHtml` (sync) so both paths are consistent. Keep `SHIKI_DARK_CSS` behavior.
- Modify: `apps/desktop/src/appExportActions.ts` — pass `customCss` from app settings into `exportRichHtml` (read the existing `customCss` state; if unavailable, pass `undefined`).
- Test: `packages/engine/test/export.test.ts` (assert styles present + customCss injected); `apps/desktop/test/App.test.tsx` or `appExportActions.test.ts` (assert customCss threaded through).

**Interfaces:**
- `EXPORT_BODY_CSS` — a braces-valid CSS string providing readable body typography (max-width centered column, sensible font-size/line-height, heading spacing, `code`/`pre` styling, dark-scheme friendly via `prefers-color-scheme` where reasonable). Keep it small and self-contained (no external fonts).
- `ExportRichHtmlOptions.customCss?: string` — appended as a second `<style>` after the base CSS so user rules win.
- Desktop reads custom CSS from the existing settings state and forwards it; no new settings UI required.

**Tasks:**

- [ ] **Task C1: Base export CSS**
  - Create `packages/engine/src/export/styles.ts` with `EXPORT_BODY_CSS`.
  - It must style `body`, headings, `p`, `code`/`pre`, `blockquote`, `table`, `img` (max-width:100%), lists. Center a readable column (mirror the editor's `--omd-content-width` intent with a fixed `max-width: 720px; margin: 0 auto; padding: 24px`).

- [ ] **Task C2: Inject into export**
  - In `html.ts`, add `customCss?: string` to `ExportRichHtmlOptions`.
  - `exportRichHtml` head becomes: `<meta charset="utf-8"><title>oh-my-md</title><style>${EXPORT_BODY_CSS}</style>${opts.customCss ? `<style>${opts.customCss}</style>` : ""}${SHIKI_DARK_CSS}`.
  - Apply `EXPORT_BODY_CSS` (without customCss) to the sync `exportHtml` output too, for parity.

- [ ] **Task C3: Desktop threading**
  - In `appExportActions.ts` `exportCurrent`, pass `customCss` (the existing app customCss string) into `exportRichHtml(view.state, { ...exportOptions, customCss })`. Ensure `undefined` when not set.

- [ ] **Task C4: Tests**
  - Engine: assert `exportRichHtml` output contains the base CSS and, when `customCss` is given, contains it after the base CSS. Also assert `exportHtml` contains base CSS.
  - Desktop: assert `exportCurrent` passes customCss through (mock `exportRichHtml` or spy). Run `pnpm --filter @omd/desktop test -- appExportActions`.

- [ ] **Task C5: Commit**
  - `git add` engine + desktop files + tests; `git commit -m "feat: self-contained export HTML with base typography and custom CSS"`.

---

## Feature D — Remote-image PDF/PNG export warning (`feat/remote-img-pdf-warn`)

**Why:** `exportRichHtml` intentionally does not inline remote `http(s)` images (engine `html.ts:306`). When a user exports to PDF/PNG, those images are dropped/need network, yet nothing tells them. A transient status warning closes the gap cheaply.

**Files (desktop):**
- Modify: `apps/desktop/src/appExportActions.ts` — detect remote images in the document before PDF/PNG export and surface a notice.
- Modify: `apps/desktop/src/App.tsx` — pass the existing transient-status notifier into `exportCurrent` (or have `exportCurrent` accept an `onNotice` callback).
- Modify: `apps/desktop/src/i18n/messages/{zh,en}.ts` — add `export.remoteImageWarning`.
- Test: `apps/desktop/test/appExportActions.test.ts` (assert the notice fires when a remote image is present, and does not when only local images exist).

**Interfaces:**
- Detection: scan `view.state.doc.toString()` (export-time only, not per-keystroke — O(doc) is fine here) for markdown images with a remote `http(s)` src: `/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/`. (This matches the engine's own remote-image rule in `html.ts:306`.)
- `exportCurrent(services, view, kind, exportOptions, onNotice?)` — when `kind` is `"pdf"` or `"png"` and the doc has ≥1 remote image, call `onNotice?.(t("export.remoteImageWarning"))` before invoking `exportPreview`.
- App passes its existing transient-status notifier (the `createTransientStatusNotifier(...)` result bound to `setTransientStatus`) as `onNotice`.

**Tasks:**

- [ ] **Task D1: Detection + notice**
  - In `appExportActions.ts`, add a helper `hasRemoteImages(doc: string): boolean` using the regex above.
  - Extend `exportCurrent` signature with `onNotice?: (message: string) => void`. For `pdf`/`png`, if `hasRemoteImages(view.state.doc.toString())`, call `onNotice(t("export.remoteImageWarning"))` prior to `exportPreview`.
  - Add i18n keys `export.remoteImageWarning` to zh/en (e.g. zh: "导出 PDF/PNG 可能缺少远程图片（未内嵌网络图片）").

- [ ] **Task D2: Wire in App**
  - In `App.tsx`, update the `exportCurrent` call site(s) to pass the transient-status notifier as `onNotice`. Locate the existing `notifyTransient`/`createTransientStatusNotifier` binding.

- [ ] **Task D3: Tests**
  - Add `apps/desktop/test/appExportActions.test.ts`: mock `services.exportPreview` and `navigator`/clipboard as needed; assert that exporting a doc containing `![](https://example.com/x.png)` to `pdf` invokes `onNotice` with the warning message, while a doc with only `![](assets/x.png)` does not. Run `pnpm --filter @omd/desktop test -- appExportActions`.

- [ ] **Task D4: Commit**
  - `git add` desktop files + tests + i18n; `git commit -m "feat: warn when exporting PDF/PNG with remote images"`.

---

## Self-Review Notes

- Scope coverage: A (paste) ✓, B (sub/sup + math delimiters) ✓, C (export CSS + customCss) ✓, D (remote-image warning) ✓. No Rust changes required — correct, since none of these touch native effects.
- Placeholder scan: each task has concrete files, signatures, and test commands. No "TBD".
- Type consistency: `pastePlainText(view)`, `ExportRichHtmlOptions.customCss`, `exportCurrent(..., onNotice?)`, `hasRemoteImages(doc)` are the cross-task names; App and tests must use exactly these.
- Conventions: engine stays React/Tauri-free; i18n keys paired; no `any`; no complete-tree parse; commit messages `<type>: <why>`.
