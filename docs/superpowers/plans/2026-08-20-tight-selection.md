# Plan: Typora-style tight selection highlight

Date: 2026-08-20. Type: bug fix (user-visible editor interaction).

## Problem

When the user selects text spanning multiple lines (or up to a line end / across an
empty line), the selection highlight extends past the last selected character to
(nearly) the right edge of the editor column, and empty lines inside the selection
render a full-width bar. Typora truncates each line's highlight right after the
last selected glyph. Screenshots from the user compare the two (Typora = expected).

## Root cause (verified)

- `apps/desktop/src/Editor.ts:171` enables stock `drawSelection()` from
  `@codemirror/view@6.43.8`, with no custom selection CSS anywhere
  (`styles.css` has zero selection rules; engine adds no selection styling).
- In the installed package (`node_modules/.pnpm/@codemirror+view@6.43.8/.../dist/index.js`):
  - `rectanglesForRange` computes `leftSide`/`rightSide` from
    `view.contentDOM.getBoundingClientRect()` minus line padding (lines 9324-9328).
  - `drawForLine`'s `addSpan` pushes `toOpen ? rightSide : toCoords.right`
    (lines 9373-9376): any line whose selection crosses the line break gets a rect
    running to the content-box right edge instead of the last glyph.
  - Intermediate lines (including empty ones) are covered by ONE full-width band
    `piece(leftSide, top.bottom, rightSide, bottom.top)` (line 9345).
- This is intentional upstream design (the `drawSelection` doc comment says it
  "fills the horizontal space after a line"). The maintainer confirmed it is not
  configurable and recommends a custom selection display
  (discuss.codemirror.net threads 9495 and 9735; codemirror/dev#1546).
- Single-line selections and the LAST line of a multi-line selection already stop
  at the last character (`toCoords.right`); only "open" line ends and the
  `between` band over-extend.

## Goal (spec)

Replace stock `drawSelection()` with a vendored selection-drawing extension
("tight selection") in the desktop domain so that:

1. Every line of a multi-line selection ends its highlight at the line's text end
   plus a small nub (named constant, ~2px) — never at the editor right edge.
   Mirrored for RTL bidi lines (clamp at the left/text end).
2. Intermediate lines are drawn per line (each ending at its own text end + nub),
   not as one full-width band. An empty intermediate line renders a small
   nub-width bar at the line start, not a full-width bar.
3. Line STARTS keep stock behavior (from line's text start / `leftSide`), so a
   fully selected line still reads as selected from its beginning.
4. Everything else about stock selection drawing is preserved: blinking cursor
   layer (`.cm-cursorLayer` / `.cm-cursor`), range cursors
   (`drawRangeCursor`), multi-cursor rendering, native selection hidden via
   `Prec.highest` theme, stock class names (`cm-selectionLayer`,
   `cm-selectionBackground`) so the package baseTheme colors keep applying.
5. `tightSelection(config?)` accepts `{ cursorBlinkRate?, drawRangeCursor? }`
   with stock defaults (1200 / true). iOS selection handles are out of scope
   (macOS-first desktop app).

## Non-goals

- No engine (`packages/engine`) changes; selection drawing is desktop host behavior.
- No `nativeSelectionHidden` facet replication (private upstream; its only effect
  is skipping a cursor re-measure under line wrapping — negligible).
- No bidi rework beyond mirroring the stock clamp on the end edge.
- No README/CHANGELOG changes (release-time artifacts).

## Tasks

### Task 1 — Vendored tight selection module + geometry unit tests

Create `apps/desktop/src/tightSelection.ts` exporting:

- `tightSelection(config?: TightSelectionConfig): Extension` — returns
  `[selectionConfig.of(config ?? {}), cursorLayer, tightSelectionLayer,
  hideNativeSelection]` (own Facet; ported pieces below).
- `tightSelectionMarkers(view): RectangleMarker[]` — the selection layer's
  markers function, exported for tests.
- Port from the installed 6.43.8 dist (convert compiled JS to strict TS; keep
  upstream structure and a header comment attributing
  `@codemirror/view 6.43.8 src/drawSelection.ts` / `src/layer.ts`, MIT):
  - `getBase`, `wrappedLine`, `blockAt`, `piece`/`pieces`, `configChanged`,
    `setBlinkRate`, `cursorLayer`, `hideNativeSelection`, and
    `rectanglesForRange`/`drawForLine` renamed `tightRectanglesForRange` etc.
  - Modification A (in `addSpan`): clamp line-END edges to text end + nub.
    LTR: `ltr && toOpen ? Math.min(rightSide, toCoords.right + NUB_PX) : toCoords.right`.
    RTL: `!ltr && toOpen ? Math.max(leftSide, toCoords.left - NUB_PX) : toCoords.left`.
    Line-START edges stay stock (`leftSide`/`rightSide` per direction).
  - Modification B (between band): when the stock between-condition fires,
    instead of one full-width piece, iterate the intermediate text blocks
    (`view.viewportLineBlocks`, public API) strictly between the start block's
    `to` and the end block's `from`, and push `pieces(drawForLine(null, null,
    block))` per block (both bounds open → Modification A clamps each line's
    end; empty lines fall to the fallback span and get a nub-width bar).
    Keep the stock else-if half-line merge branch unchanged.
  - `const NUB_PX = 2` named constant in the module (visual constant, local home).
- Do NOT commit (controller owns commits — worktree has unrelated dirty files).

Tests in `apps/desktop/test/tightSelection.test.ts` using a fake-view harness
(happy-dom has no layout, so `coordsAtPos` etc. are stubbed; duck-typed object
cast to `EditorView` with a comment, following the repo's documented cast
pattern). The fake view provides a real `EditorState` doc, stubbed
`coordsAtPos` (col → x via a fixed char width), `visibleRanges`,
`bidiSpans` (LTR spans; one RTL case), `textDirection`, `viewportLineBlocks`
(real `BlockInfo` instances), `contentDOM` with a stubbed
`getBoundingClientRect`, `scrollDOM`/`dom` rects, `scaleX/scaleY = 1`,
`defaultLineHeight`, `elementAtHeight`, `lineWrapping = false`. Assert:

1. Single-line range: one marker; right edge == text end (no nub).
2. Multi-line range (3 lines, partial first/last): top-line marker right edge ==
   top line text end + NUB (not content right edge); bottom line starts at
   leftSide and ends at its text end; middle line has its own marker ending at
   its text end + NUB.
3. Empty middle line: small marker (~NUB width), not full width.
4. RTL bidi span: end clamp lands on the left/text end.
5. Cursor layer markers: empty range yields a cursor marker; non-empty range
   yields one when `drawRangeCursor` is true.
6. Composition smoke: a real `EditorView` created with `tightSelection()` in
   happy-dom (coordsAtPos → null ⇒ empty markers) throws nothing
   (`exceptionSink` empty) and mounts `.cm-selectionLayer` + `.cm-cursorLayer`.

Run: `pnpm --filter @omd/desktop test` (all pass) and
`pnpm --filter @omd/desktop build` (typecheck+build pass).

### Task 2 — Wire into the editor + docs

- `apps/desktop/src/Editor.ts`: replace the `drawSelection` import and the
  `drawSelection()` extension (line 171) with `tightSelection()`. No other
  extension-list changes.
- Add a desktop test asserting the editor state no longer contains stock
  `drawSelection` and instantiates with the vendored one (e.g. instantiate
  `createEditorState` in happy-dom and assert the layer DOM exists / exception
  sink stays empty — follow existing `Editor.test.ts` patterns).
- Docs (additive edits only — these files carry unrelated uncommitted changes):
  - `docs/memory/known-gotchas.md`: new entry — CM6 `drawSelection` extends
    selection to the content right edge by design and it is not configurable;
    selection drawing is vendored in `apps/desktop/src/tightSelection.ts`;
    re-diff the vendored geometry against upstream whenever `@codemirror/view`
    is bumped; do not re-add stock `drawSelection()`.
  - `docs/manual-qa.md`: add a manual check — multi-line selection highlight
    stops at the last character per line; empty lines show a small bar; cursor
    blink and multi-cursor unaffected.
  - `apps/desktop/AGENTS.md` (clean in git): under "CodeMirror Host Rules", note
    that selection drawing is the vendored tight-selection extension, not stock
    `drawSelection`.
- Run `pnpm --filter @omd/desktop test` and `pnpm --filter @omd/desktop build`.

## Global Constraints

- TypeScript strict; no `any` except documented `unknown as` casts for
  runtime-only/fake-view members (repo precedent).
- Do not touch or revert unrelated working-tree changes (notably
  `apps/desktop/src/App.tsx`, `imagePaste.ts`, `pastePlainText.ts`, their tests,
  `.vscode/settings.json`, and the pending hunks in `docs/manual-qa.md` /
  `docs/memory/known-gotchas.md` — docs edits are additive sections only).
- Implementers do not run `git add`/`git commit`; the controller stages
  surgically (shared dirty files) and commits once after final review.
- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`.
- Named constants for shared values; `NUB_PX` lives in `tightSelection.ts`.
- Desktop-domain only: no `packages/engine` changes; keep the vendored module
  free of React/Tauri imports.
- Verification gates: `pnpm --filter @omd/desktop test` and
  `pnpm --filter @omd/desktop build` must pass; no new lint/format claims.

## Risks / notes

- Vendored code drifts from upstream on `@codemirror/view` upgrades — mitigated
  by the version-pinned header comment and the gotchas entry.
- `viewportLineBlocks` per-line drawing skips unrendered intermediate lines
  (stock painted one band across the gap); this matches "highlight only where
  lines render" and is acceptable.
- Blink/cursor code is copied verbatim; if upstream changed it since 6.43.8 the
  vendored copy stays consistent with the installed version.
