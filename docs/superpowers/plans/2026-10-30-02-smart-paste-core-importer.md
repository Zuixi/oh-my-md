# Smart Paste Core Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace string-level HTML conversion with a pure, deterministic engine importer that preserves semantic formatting and never introduces accidental Markdown syntax.

**Architecture:** Parse untrusted clipboard HTML into a small immutable Paste AST, normalize only semantic structure, serialize with an engine-owned trigger policy, and use at most one bounded Lezer parse as a circuit breaker. This plan exports pure APIs but does not switch desktop DOM/menu paste ownership or delete Turndown.

**Tech Stack:** TypeScript, DOMParser, CodeMirror 6 `EditorState`, Lezer Markdown, Vitest, deterministic fixture/property tests.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Paste AST is temporary and immutable; it has no node IDs, DOM paths, source map, or Lezer nodes.
- Normalizer may read semantic tag/style facts but never returns sanitized raw HTML.
- Drop color, background, font size/family, class, `data-*`, Office CSS, and presentation-only `span`.
- `MarkdownTriggerPolicy` emits literal text safely but never parses persisted Markdown.
- Plain fast path and structured validation are mutually exclusive; each conversion performs at most one new local parse.
- Validation failure invokes whole-fragment strict serialization with no second parse.
- Select the candidate before parsing and plan its host boundaries before validation. Nothing may rewrite a validated insertion afterward.
- Conversion failure preserves visible literal text through the engine fallback planner; it must not become an implicit Paste as Markdown Source command.
- Unknown/dangerous tags flatten to visible children; raw clipboard HTML never reaches `innerHTML`.
- Complex rowspan/colspan tables degrade to visible cell text until the separate complex-table plan lands.
- Keep each new production module narrowly scoped (target under 500 LoC, hard review at 800 LoC); split by model, normalization, URL policy, trigger policy, serialization, validation, and orchestration instead of creating another paste monolith.

## File Map

- Create `packages/engine/src/paste/model.ts`: Paste AST, asset, diagnostic, and plan types.
- Create `packages/engine/src/paste/normalizeHtml.ts`: inert DOM → Paste AST.
- Create `packages/engine/src/paste/urlPolicy.ts`: shared Link/Image protocol normalization.
- Create `packages/engine/src/paste/triggerPolicy.ts`: context-specific literal emission rules.
- Create `packages/engine/src/paste/serialize.ts`: minimal and strict serializers.
- Create `packages/engine/src/paste/validate.ts`: bounded context window and single-parse invariants.
- Create `packages/engine/src/paste/smartPaste.ts`: public prepare/plan orchestration.
- Modify `packages/engine/src/paste/blockBoundaries.ts`: accept serializer-owned boundary facts while preserving legacy callers until cutover.
- Create `packages/engine/src/paste/limits.ts`: named DOM-depth/node and validation-window limits, tuned by the importer benchmark.
- Create `packages/engine/test/fixtures/paste/*.json`: human-authored clipboard fixtures.
- Keep `packages/engine/src/paste/htmlPaste.ts` active until the host-cutover plan.

---

### Task 1: Lock the importer contract and fixture corpus

**Files:**
- Create: `packages/engine/src/paste/model.ts`
- Create: `packages/engine/test/pasteModel.test.ts`
- Create: `packages/engine/test/fixtures/paste/browser-basic.json`
- Create: `packages/engine/test/fixtures/paste/office-style-noise.json`
- Create: `packages/engine/test/fixtures/paste/literal-markdown.json`
- Create: `packages/engine/test/fixtures/paste/verbatim-and-code.json`
- Create: `packages/engine/test/fixtures/paste/tables.json`
- Create: `packages/engine/test/fixtures/paste/security.json`

**Interfaces:**
- Produces the exact public/paste-internal types:

```ts
export type PasteInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong" | "emphasis" | "strike" | "highlight" | "underline" | "kbd" | "subscript" | "superscript"; readonly children: readonly PasteInline[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly title: string | null; readonly children: readonly PasteInline[] }
  | { readonly type: "image"; readonly alt: string; readonly title: string | null; readonly source: PasteImageSource }
  | { readonly type: "hardBreak" }

export type PasteImageSource =
  | { readonly kind: "url"; readonly value: string }
  | { readonly kind: "embedded"; readonly key: string; readonly mime: string; readonly base64: string }
  | { readonly kind: "unavailable"; readonly key: string }

export type PasteBlock =
  | { readonly type: "paragraph"; readonly children: readonly PasteInline[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly PasteInline[] }
  | { readonly type: "blockquote"; readonly children: readonly PasteBlock[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly start: number | null; readonly items: readonly PasteListItem[] }
  | { readonly type: "codeBlock"; readonly language: string; readonly value: string }
  | { readonly type: "table"; readonly table: PasteTable }
  | { readonly type: "horizontalRule" }

export interface PasteListItem {
  readonly checked: boolean | null
  readonly children: readonly PasteBlock[]
}

export interface PasteTableCell {
  readonly header: boolean
  readonly scope: "row" | "col" | null
  readonly rowSpan: number
  readonly colSpan: number
  readonly align: "left" | "center" | "right" | null
  readonly blocks: readonly PasteBlock[]
}
export interface PasteTableRow { readonly cells: readonly PasteTableCell[] }
export interface PasteTable { readonly rows: readonly PasteTableRow[]; readonly requiresComplexHtml: boolean }
export interface PasteDocument { readonly blocks: readonly PasteBlock[] }
export interface PasteAsset { readonly key: string; readonly mime: string; readonly base64: string; readonly alt: string }
export interface PasteDiagnostic { readonly kind: "strictFallback" | "unsupportedTable" | "droppedStyle" | "rejectedUrl" | "unresolvedAsset"; readonly count: number }
export interface SmartPasteInput { readonly html: string; readonly plainText: string }
export interface PreparedSmartPaste {
  readonly policy: "semantic" | "literalFallback"
  readonly document: PasteDocument
  readonly plainText: string
  readonly assets: readonly PasteAsset[]
  readonly unavailableImageKeys: readonly string[]
  readonly isSingleImageOnly: boolean
  readonly diagnostics: readonly PasteDiagnostic[]
}
export interface PasteBoundary {
  readonly start: "inline" | "block"
  readonly end: "inline" | "block" | "opaque"
}
export interface SerializedPaste {
  readonly text: string
  readonly boundary: PasteBoundary
  readonly diagnostics: readonly PasteDiagnostic[]
}
export interface SmartPastePlan { readonly kind: "plain" | "markdown"; readonly text: string; readonly diagnostics: readonly PasteDiagnostic[] }
```

- Fixture JSON has exact keys `name`, `html`, `plainText`, `context`, `expectedMarkdown`, `expectedPath`, and `expectedDiagnostics`.

- [x] **Step 1: Write the fixture loader and immutability tests**

Assert fixtures are human-authored expected strings, every embedded asset key is unique within one document, and recursive `Object.freeze` prevents mutation in tests.

- [x] **Step 2: Populate exact first-wave fixtures**

Include at minimum:

- `access_token`, literal `# title`, `$x$`, `**bold**`, brackets, backticks, and literal backslashes;
- headings, paragraphs, nested ordered/unordered lists, non-1 ordered starts, checked/unchecked task items, blockquotes, code, links, images, simple tables, and supported paragraph/list/break content inside table cells;
- CSS bold/italic/underline/line-through conversion;
- color/background/font-size/style-only spans producing no HTML/style output;
- CJK underscore, RTL, emoji, Entity, NBSP, CRLF;
- script/event/javascript URL/malformed tags;
- rowspan/colspan expected to preserve visible cell text plus one `unsupportedTable` diagnostic.
- `th[scope=row]` versus `th[scope=col]`, retained distinctly in the AST even while complex tables use visible-text fallback.

- [x] **Step 3: Run the model tests**

```bash
pnpm --filter @omd/engine exec vitest run test/pasteModel.test.ts
```

Expected: PASS for schema/fixture integrity; no importer behavior exists yet.

- [x] **Step 4: Commit the contract and corpus**

```bash
git add packages/engine/src/paste/model.ts packages/engine/test/pasteModel.test.ts packages/engine/test/fixtures/paste
git commit -m "test: define semantic paste corpus"
```

### Task 2: Inert HTML normalizer

**Files:**
- Create: `packages/engine/src/paste/normalizeHtml.ts`
- Create: `packages/engine/src/paste/limits.ts`
- Create: `packages/engine/src/paste/urlPolicy.ts`
- Create: `packages/engine/test/pasteNormalize.test.ts`
- Create: `packages/engine/test/pasteUrlPolicy.test.ts`
- Create: `packages/engine/test/pasteNormalizeFuzz.test.ts`
- Modify: `packages/engine/src/paste/model.ts`

**Interfaces:**
- Consumes `PasteDocument`, `PasteAsset`, and `PreparedSmartPaste` from Task 1.
- Produces:

```ts
export function normalizeHtmlPaste(input: SmartPasteInput): PreparedSmartPaste
export function preparePlainTextFallback(plainText: string): PreparedSmartPaste
export function normalizePasteUrl(value: string, kind: "link" | "image"): string | null
```

`limits.ts` starts with explicit conservative guards (`MAX_PASTE_DOM_DEPTH = 256`, `MAX_PASTE_DOM_NODES = 200_000`) and exports them for boundary tests. Task 6 may tighten them from measured evidence before host cutover; they are never duplicated in the desktop.

- [x] **Step 1: Add failing tag and style normalization tests**

Assert exact ASTs for semantic tags and this inline-style input:

```html
<p>
  <span style="color:#111;background:#fff;font-size:15px">plain</span>
  <span style="font-weight:700">bold</span>
  <span style="font-style:italic;text-decoration-line:underline line-through">mixed</span>
</p>
```

Expected AST contains plain Text, Strong, and nested Emphasis/Underline/Strike only. It contains no style string, class, color, background, or font size.

Add tests that `script`, `style`, `svg`, event attributes, form controls, and unknown tags preserve only safe visible descendants; `javascript:` links become text plus `rejectedUrl`. The sole form-control exception is a leading direct-child `input[type=checkbox]` inside a list item: in the inert document, read only its boolean checked state into `PasteListItem.checked`, never preserve the element or any attribute; checkboxes elsewhere are dropped.

URL-policy cases cover HTTP/HTTPS, mailto, fragments, relative Markdown paths, entity/control-character normalization, mixed-case schemes, protocol-relative URLs, and rejection of `javascript:`, every `data:` URL passed to the URL policy, `vbscript:`, and ambiguous control-character schemes. Test separately that the normalizer recognizes permitted `data:image/*` before URL policy, extracts it into a `PasteAsset`, and rejects non-image or malformed data payloads.

Add a deterministic bounded generator that combines unknown elements, malformed nesting, SVG/MathML/form/media tags, event/data attributes, hostile URL spellings, style noise, deep wrappers, and Unicode text. Assert normalization never throws, never executes a callback/fetch, never returns raw tags/attributes, and always preserves the safe visible descendant text. Through an engine-internal test-only limits parameter, add exact depth/node limit-minus-one and limit-plus-one cases without constructing a 200,000-node unit fixture; overflow returns `preparePlainTextFallback(input.plainText)` with one aggregate diagnostic instead of recursing or silently truncating rich structure. The limits override is never part of the production public API.

- [x] **Step 2: Run normalization tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/pasteNormalize.test.ts test/pasteUrlPolicy.test.ts test/pasteNormalizeFuzz.test.ts
```

- [x] **Step 3: Implement detached DOM traversal**

Use `new DOMParser().parseFromString(html, "text/html")` and read the detached tree. Traverse iteratively with explicit depth/node accounting; never append parsed nodes to `document`, clone event attributes, fetch resources, or emit raw HTML.

Normalize HTML whitespace once; preserve NBSP and `pre` bytes; convert `<br>` to `hardBreak`; retain ordered-list start and task-checkbox state; collapse adjacent identical inline semantics and empty wrappers. Preserve bounded paragraph/list/code structure inside table-cell `blocks` so the existing cell mini-document can represent it; complex-table serialization later flattens only block kinds outside its closed inline subset. Parse known style properties through the element style/CSSOM surface and ignore every other property.

Successful normalization returns `policy: "semantic"`. Keep `preparePlainTextFallback` in `normalizeHtml.ts` as a no-DOM constructor of literal Text/Paragraph/HardBreak nodes with `policy: "literalFallback"`, empty asset lists and one `strictFallback` diagnostic. It must not import the planner or retry HTML parsing. Diagnostics describe the outcome; the explicit policy, not the presence of a diagnostic, controls fallback routing.

Use `normalizePasteUrl` as the only Link/Image URL gate. For `data:image/*`, extract validated MIME/base64 into `PasteAsset` and store an embedded key in the Image node. The key identifies asset bytes only; it never identifies a Paste AST node or output range. For `blob:`/unreadable `file:`, assign a deterministic asset key (`{ kind: "unavailable", key }`) and record it in `PreparedSmartPaste.unavailableImageKeys` while retaining `alt`. These keys identify unresolved assets, not a correspondence to clipboard File order. Plan 03 must leave them unresolved for mixed rich documents unless an independently verified adapter supplies explicit identity; equal counts or matching MIME do not prove identity.

Set `PreparedSmartPaste.isSingleImageOnly = true` when the normalized document consists solely of a single image (or a single paragraph containing only one image). This supports an explicit single-image clipboard representation, not positional matching inside a rich document. Preserve normalized `scope: "row" | "col" | null` on cells, with `null` for td, missing or unsupported scope. Build rows/cells and set `requiresComplexHtml` when any effective span exceeds 1, header/scope semantics cannot be represented by GFM, or a cell block cannot be encoded losslessly by the shared cell mini-document.

- [x] **Step 4: Run normalization and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/pasteNormalize.test.ts test/pasteUrlPolicy.test.ts test/pasteNormalizeFuzz.test.ts test/pasteModel.test.ts
pnpm test
```

- [x] **Step 5: Commit the normalizer**

```bash
git add packages/engine/src/paste/model.ts packages/engine/src/paste/limits.ts packages/engine/src/paste/normalizeHtml.ts packages/engine/src/paste/urlPolicy.ts packages/engine/test/pasteNormalize.test.ts packages/engine/test/pasteUrlPolicy.test.ts packages/engine/test/pasteNormalizeFuzz.test.ts
git commit -m "feat: normalize clipboard html into paste ast"
```

### Task 3: Markdown trigger policy and deterministic serializers

**Files:**
- Create: `packages/engine/src/paste/triggerPolicy.ts`
- Create: `packages/engine/src/paste/serialize.ts`
- Create: `packages/engine/test/pasteTriggerPolicy.test.ts`
- Create: `packages/engine/test/pasteSerialize.test.ts`
- Create: `packages/engine/test/pasteSerializerProperty.test.ts`
- Modify: `packages/engine/src/parse/markdown.ts`
- Modify: `packages/engine/src/parse/math.ts`
- Modify: `packages/engine/src/parse/footnotes.ts`
- Modify: `packages/engine/src/parse/scan.ts`
- Test: `packages/engine/test/math.test.ts`
- Test: `packages/engine/test/footnotes.test.ts`
- Test: `packages/engine/test/inlineMarks.test.ts`

**Interfaces:**
- Produces:

```ts
export type PasteTextContext =
  | "paragraph"
  | "lineStart"
  | "emphasis"
  | "linkLabel"
  | "linkDestination"
  | "tableCell"
  | "htmlText"
  | "htmlAttribute"

export interface SerializePasteOptions {
  readonly mode: "minimal" | "strict"
  readonly resolveAsset: (key: string) => string | null
}

export function escapePasteText(value: string, context: PasteTextContext, mode: "minimal" | "strict"): string
export function serializePasteDocument(document: PasteDocument, options: SerializePasteOptions): SerializedPaste
```

- [x] **Step 1: Add failing policy tests**

Use table-driven exact expectations:

```ts
expect(escapePasteText("access_token", "paragraph", "minimal")).toBe("access_token")
expect(escapePasteText("# title", "lineStart", "minimal")).toBe("\\# title")
expect(escapePasteText("$x$", "paragraph", "minimal")).toBe("\\$x\\$")
expect(escapePasteText("**bold**", "paragraph", "minimal")).toBe("\\*\\*bold\\*\\*")
expect(escapePasteText("a | b", "tableCell", "minimal")).toBe("a \\| b")
expect(escapePasteText("a \\ b", "tableCell", "minimal")).toBe("a \\\\ b")
expect(escapePasteText("a \\| b", "tableCell", "minimal")).toBe("a \\\\\\| b")
```

Cover CommonMark punctuation, CJK underscore, GFM task/table/strike, math, highlight, sub/sup, emoji, footnote, front matter, HTML/entity/autolink boundaries, indentation, tab, and delimiter adjacency.

Add a drift test that names every extension in `markdownLanguageSupport()` and requires a corresponding trigger-policy fixture category.

Add parser/serializer reciprocity cases: escaped opening `$` does not create `InlineMath`; escaped closing `$` remains content inside math; escaped `[^` does not create `FootnoteReference`; escaped `]` can occur inside a footnote label; escaped fixed HTML opening tags remain literal; and a same-name closing tag inside inline code does not terminate `<u>`, `<mark>`, or `<kbd>` early.

Generate bounded Text-node strings from every ASCII punctuation mark, whitespace boundaries, backslash runs, CJK/RTL/emoji, and dialect delimiter combinations. In every serializer context, assert deterministic bytes; in strict mode, parse the result and prove it adds no unrequested semantic node while preserving visible literal text.

- [x] **Step 2: Run policy/serializer tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/pasteTriggerPolicy.test.ts test/pasteSerialize.test.ts test/pasteSerializerProperty.test.ts test/math.test.ts test/footnotes.test.ts test/inlineMarks.test.ts
```

- [x] **Step 3: Implement minimal and strict emission**

Minimal mode applies CommonMark flanking and line-start rules. Strict mode escapes all CommonMark-escapable ASCII punctuation, doubles literal backslashes, prevents line-start indentation from becoming indented code, uses explicit blank block separators, and chooses code/fence delimiters longer than content runs.

Make the custom dialect parsers honor the same escape contract: `InlineMath` and `FootnoteReference` reject escaped openers and skip escaped closers; `parseHtmlPair` rejects an escaped opener and skips inline-code spans while looking for its matching fixed closing tag. These are parser boundary fixes, not a second paste parser.

Serialize semantic nodes to project-standard Markdown. Preserve ordered-list starts and task states in canonical list markers. Emit `<u>` and `<kbd>` only for their fixed typed nodes; emit `==`, `~~`, `~`, and `^` for project dialect nodes. Return `PasteBoundary` facts from the known first/last emitted nodes, not by reparsing emitted Markdown.

GFM-capable tables serialize each cell's bounded mini-document through Plan 01's shared grammar and round-trip with `parseCell(source, { pipeEscapes: "gfm-table" })`. For literal Text, `tableCell` escaping doubles literal backslashes and shields literal pipes, so visible `a \| b` becomes `a \\\| b` in row source. Do not blanket-escape an already-serialized mini-document: that would escape semantic markers and corrupt code spans. Encode opaque inline-code pipe values using the inverse of the cell parser's GFM shielding rule, leaving their other literal backslashes untouched. Use `<br>` only where the cell grammar preserves the intended break. A `requiresComplexHtml` table serializes every cell block to visible strict text plus `unsupportedTable`; it does not emit arbitrary HTML in this plan.

Add explicit serializer-to-cell-model round trips for inline-code pipes, titled links/images, sub/sup and nontrivial backslash runs. Compare with human-authored semantic expectations; do not generate expected ASTs with the serializer.

- [x] **Step 4: Run serializer fixtures and determinism checks**

```bash
pnpm --filter @omd/engine exec vitest run test/pasteTriggerPolicy.test.ts test/pasteSerialize.test.ts test/pasteSerializerProperty.test.ts test/math.test.ts test/footnotes.test.ts test/inlineMarks.test.ts
pnpm test
```

Run every fixture twice and assert byte-identical output. Assert serializer output contains no `style=`, `class=`, `data-`, `color`, or `font-size` fragments.

- [x] **Step 5: Commit the serializer**

```bash
git add packages/engine/src/paste/triggerPolicy.ts packages/engine/src/paste/serialize.ts packages/engine/src/parse/markdown.ts packages/engine/src/parse/math.ts packages/engine/src/parse/footnotes.ts packages/engine/src/parse/scan.ts packages/engine/test/pasteTriggerPolicy.test.ts packages/engine/test/pasteSerialize.test.ts packages/engine/test/pasteSerializerProperty.test.ts packages/engine/test/math.test.ts packages/engine/test/footnotes.test.ts packages/engine/test/inlineMarks.test.ts
git commit -m "feat: add context aware paste serializer"
```

### Task 4: Plain fast path and one-parse circuit breaker

**Files:**
- Create: `packages/engine/src/paste/validate.ts`
- Create: `packages/engine/src/paste/smartPaste.ts`
- Create: `packages/engine/test/smartPaste.test.ts`
- Create: `packages/engine/test/pasteValidation.test.ts`
- Modify: `packages/engine/src/paste/blockBoundaries.ts`
- Test: `packages/engine/test/pasteBoundaries.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes `PreparedSmartPaste`, `serializePasteDocument`, and `normalizeBlockPaste`. `PasteBoundary` is defined in `paste/model.ts`; block-boundary code imports it as a type.
- Uses named conservative guards from `limits.ts`: `MAX_PASTE_VALIDATION_CONTEXT_CHARS = 16_384` and `MAX_PASTE_VALIDATED_INSERT_CHARS = 262_144`.
- Produces:

```ts
export type PasteRange = { readonly from: number; readonly to: number }
export type PasteAssetResolution = ReadonlyMap<string, string>

export function prepareSmartPaste(input: SmartPasteInput): PreparedSmartPaste
export function preparePlainTextFallback(plainText: string): PreparedSmartPaste

export function planSmartPaste(
  prepared: PreparedSmartPaste,
  state: EditorState,
  range: PasteRange,
  assets?: PasteAssetResolution,
): SmartPastePlan

// Existing callers may omit boundary and retain legacy behavior until cutover.
export function normalizeBlockPaste(
  doc: Text,
  from: number,
  to: number,
  insert: string,
  boundary?: PasteBoundary,
): NormalizedPaste
```

- [x] **Step 1: Add failing path-selection tests**

Assert exact `kind`, `text`, diagnostics, and parse-call count for:

- plain HTML `access_token` → original plain text, one parse;
- plain HTML `# title` → escaped Markdown, one structured parse, not fast path;
- plain-candidate validation rejection → strict literal output with no structured retry and one parse total;
- real `<h1>title</h1>` → heading Markdown;
- insertion mid-paragraph/list/blockquote without swallowing prefix/suffix;
- validation mismatch → strict whole-fragment result and still one parse total;
- unavailable/incomplete existing tree → strict result without forcing a complete parse;
- using an engine-internal test-only limits override, insertion/context exactly below each validation limit may parse once; above either limit chooses strict output with zero parse calls, without making unit tests parse a 262 KiB fixture;
- unresolved embedded asset → alt text plus one `unresolvedAsset` diagnostic;
- mid-line `<h1>Title</h1>` between `hello` and ` world` validates the final `\n\n# Title\n\n` insertion, producing Paragraph/Heading/Paragraph rather than rejecting an unseparated fragment;
- structured and strict candidates preserve source outside the replacement range for paragraph/list/quote hosts, dangling backslashes, adjacent emphasis/link delimiters, and selected ranges spanning block boundaries;
- `preparePlainTextFallback("# title\n$x$\n**x**")` inserts protected visible text, adds one aggregate `strictFallback` diagnostic, and never invokes the HTML parser;

Instrument the parser through an injected internal test hook; do not export that hook. Expose `prepareSmartPaste`, `preparePlainTextFallback`, `planSmartPaste` and their public types through `src/index.ts`.

- [x] **Step 2: Run path tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/smartPaste.test.ts test/pasteValidation.test.ts
```

- [x] **Step 3: Implement bounded context and validation**

Use only the current syntax tree's covered top-level nodes around the range, capped by the named context limit. First resolve a host boundary decision from that covered context and serializer-owned `PasteBoundary` facts. Apply `normalizeBlockPaste` exactly once to materialize each candidate, before calculating the insertion envelope or checking its size. If the context or final candidate exceeds its guard, choose strict output without parsing. Otherwise build synthetic prefix + final insertion + suffix and parse it once with the same Markdown language. Reject when normalized Paragraph/HardBreak boundaries differ, a key block kind differs, a semantic node crosses into stable prefix/suffix, key inline counts differ inside the insertion envelope, or literal text creates unrequested HTML/math/link/emphasis/table nodes.

Return the validated candidate unchanged: no post-validation boundary normalization, trimming, escaping or asset substitution. Do not emit node mappings or mismatch locations. If the tree/window is unavailable, use conservative source-preserving boundaries and strict serialization without forcing a complete parse. If that host cannot safely carry the structured fragment, lower the whole fragment to visible strict literal text with explicit block isolation rather than assuming punctuation escaping alone protects its neighbors.

- [x] **Step 4: Implement orchestration and block boundaries**

Normalize CRLF/CR to LF only for the HTML/plain equivalence check. Before parsing, use the trigger policy plus covered host context to select one candidate: exact plain text only for Text/Paragraph/HardBreak documents with equal visible text/boundaries and no known trigger hazard; otherwise minimal structured Markdown. Thus literal `# title` chooses the structured candidate before a parse, while `access_token` may choose plain.

Validate that final candidate once. A failed plain candidate goes directly to strict literal output; a failed structured candidate goes directly to whole-fragment strict serialization. Neither failure gets a second validation parse. Materialize strict output with the same host boundary decision before returning it; it has its own fixture/property guarantees and is never parsed again in production.

`preparePlainTextFallback` is the no-DOM constructor from Task 2. `planSmartPaste` branches on `policy: "literalFallback"`, bypasses plain/minimal candidates and emits host-aware strict literal output with zero validation parses. Normalizer limit overflow and host conversion failure reuse this path. Explicit Paste as Plain Text does not call it.

- [x] **Step 5: Run focused/full tests and commit**

```bash
pnpm --filter @omd/engine exec vitest run test/smartPaste.test.ts test/pasteValidation.test.ts test/pasteBoundaries.test.ts
pnpm test
pnpm --filter @omd/desktop build
git diff --check
git add packages/engine/src/paste/validate.ts packages/engine/src/paste/smartPaste.ts packages/engine/src/paste/blockBoundaries.ts packages/engine/src/index.ts packages/engine/test/smartPaste.test.ts packages/engine/test/pasteValidation.test.ts packages/engine/test/pasteBoundaries.test.ts
git commit -m "feat: plan smart paste with one parse guard"
```

### Task 5: Fixed Kbd syntax without a generic HTML stack

**Files:**
- Modify: `packages/engine/src/parse/highlight.ts`
- Modify: `packages/engine/src/decorations/inline.ts`
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Modify: `packages/engine/src/decorations/widgets/tableCell.ts`
- Modify: `apps/desktop/src/styles.css`
- Create: `packages/engine/test/kbd.test.ts`
- Test: `packages/engine/test/view.test.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Adds fixed Lezer nodes `Kbd` and `KbdMark` through the existing `parseHtmlPair` mechanism.
- Does not accept Kbd attributes, generic tag names, cross-block pairs, or unclosed tags.

- [x] **Step 1: Add failing parser/projection tests**

Assert `<kbd>Ctrl</kbd>` parses as `Kbd(KbdMark,KbdMark)`, Preview hides only markers, sync/rich export emits `<kbd>Ctrl</kbd>`, and the actual TableWidget DOM contains `<kbd>Ctrl</kbd>`, not just a successful `parseCell` result. Add a table containing Kbd alongside sub/sup, a titled reference link/image and a code-span pipe; no added CellNode kind may disappear from the DOM or either exporter. Assert `<kbd class=x>`, an unclosed tag, and a cross-paragraph pair remain visible source/text.

- [x] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/kbd.test.ts test/view.test.ts test/export.test.ts test/tables.test.ts
```

- [x] **Step 3: Add the fixed extension and styling**

Extend the existing fixed HTML pair table with `kbd`; add `kbd` to CellNode and exhaustive cases in inline Preview, the extracted `widgets/tableCell.ts` renderer, and both exporters. Style `.omd-kbd` semantically in desktop CSS without importing source styles.

- [x] **Step 4: Run cross-layer checks and commit**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
git add packages/engine/src/parse/highlight.ts packages/engine/src/decorations/inline.ts packages/engine/src/parse/cell.ts packages/engine/src/decorations/widgets/tableCell.ts packages/engine/src/export/html.ts apps/desktop/src/styles.css packages/engine/test/kbd.test.ts packages/engine/test/view.test.ts packages/engine/test/export.test.ts packages/engine/test/tables.test.ts
git commit -m "feat: support fixed keyboard key markup"
```

### Task 6: Importer benchmark and documentation gate

**Files:**
- Create: `packages/engine/bench/paste.bench.ts`
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Benchmark reports DOM parse, normalization, serialization, and one-parse validation separately for typical, 100 KiB, 1 MiB, and 5 MiB generated HTML. It also measures repeated editing beside reference images in a large Markdown document and definition-change refresh, so per-Tree cache churn cannot hide whole-document work.

- [x] **Step 1: Add deterministic benchmark generators**

Generate repeated semantic paragraphs/tables in memory; do not commit copied Office documents or use random data. Assert every run returns non-empty deterministic output and records at most one parse. Record reference-index visited blocks on ordinary edits separately from initial indexing and definition edits; unrelated source blocks must not be revisited per keystroke.

- [x] **Step 2: Run the benchmark and record measured baselines in its output comments**

```bash
pnpm --filter @omd/engine exec vitest bench --run bench/paste.bench.ts --reporter=verbose
```

Do not invent a millisecond budget before measurement. Record DOM allocation as well as traversal costs: depth/node guards after DOMParser do not bound its initial allocation. If 1 MiB or 5 MiB blocks the main thread beyond an acceptable interaction window, stop before host cutover and create a worker-reader spec rather than weakening correctness. Confirm representative results in the actual desktop webview before cutover; happy-dom timing alone is not a responsiveness gate.

- [x] **Step 3: Document importer ownership and traps**

Record trigger-policy drift, one-parse maximum, no-source-map, style-dropping, and strict whole-fragment fallback. Add manual browser/Office/Docs/Sheets/code/CJK/RTL/security cases.

- [x] **Step 4: Run the pure-importer gate and commit**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm --filter @omd/engine bench
pnpm check:quality
git diff --check
git add packages/engine/bench/paste.bench.ts packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/manual-qa.md
git commit -m "perf: guard semantic paste importer"
```
