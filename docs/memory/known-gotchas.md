# Known Gotchas

Persistent traps for agents working on oh-my-md. Keep this file limited to verified behaviors that are easy to forget and costly to rediscover.

## Decoration ranges can invalidate the whole preview

CodeMirror replace decorations cannot overlap arbitrarily. A block widget that replaces a syntax node must suppress decorations from its subtree, and enclosing decorations wholly covered by the block must also be filtered.

Symptoms include `Decoration.set` throwing, disappearing preview content, or a feature working alone but failing inside blockquotes/lists.

Relevant code:

- `packages/engine/src/decorations/build.ts`
- `packages/engine/src/decorations/blocks.ts`

When adding a block rule, test the block by itself and nested under another Markdown construct.

## Editing state depends on selection, not only document text

Live preview rebuilds after selection changes. Inline syntax marks remain visible on the cursor's entire line, while block widgets disappear when the selection overlaps their source range **including both boundaries** (`sf <= to && st >= from`).

Rebuild ranges use `endLine.to + 1` as an **exclusive** end (the next line's `from`). Removal overlap must be half-open (`from < range.to`). A closed check drops the next line's point decorations (`line:omd-blockquote-N` at `line.from`). The incremental iterate does not re-enter the inner `Blockquote` that starts after that boundary, so a click on an empty `>` line leaves the following nested quote looking like a plain paragraph (marks still folded, bar gone). Deduplicate rebuilt specs against retained keys so decorations that only touch `range.to` are not added twice. Empty ranges (`from === to`, last empty line) stay closed so that line can still rebuild.

Boundary positions are intentionally different:

- Inline folding uses a line-based `nearCursor` check.
- QuoteMark is the exception: it folds unless the cursor/selection is inside `>` / `> ` itself, so typing `> ` hides the marker while the cursor stays on the same line. Inline marks inside a quote follow the same mark-range rule; line-based `nearCursor` would unfold `**` when the user clicks the quote text. A whole-line selection (triple-click) covers every mark and must not count as `cursorInside`.
- Nested quotes take their depth from the innermost `Blockquote` that owns the line (`omd-blockquote-N`). Do not paint every ancestor onto the same line.
- List indent inside a quote must start after the folded `> `; using `line.from` overlaps `replace:QuoteMark` and can make `Decoration.set` throw. List marks inside quotes also use mark-range activation, not line-based `nearCursor`.
- A list inside a quote and a quote inside a list must not share `omd-li-N`. List-in-quote keeps `omd-blockquote-N` + `omd-li-N` (bar at `--omd-bq-bar: 0`, hanging indent on). Quote-in-list emits `omd-quote-in-li-N` instead, which sets `--omd-bq-bar` to the list indent and disables hang. Reusing `omd-li-N` for both makes the quote bar jump inward on list lines. Fold leading spaces before `>` as `QuoteIndent`.
- Ordinary fenced code inside a quote must stay as line styles (`omd-codeblock` + quote classes). A `widget:block:code` replace removes those lines from the document view and splits the quote into fragments. Fold `CodeMark` / `CodeInfo` with `cursorInside`. Mermaid still needs a widget; put quote/list depth on `BlockWidget.embed` so its chrome aligns. Quote-bar CSS should use `background-image` so it composes with `omd-codeblock`'s `background-color`.
- HTML entities (`&#x1f4da;`, `&#128218;`, `&copy;`) are built-in Lezer `Entity` nodes. Preview-replace them with `widget:entity` when the cursor is not inside the entity; do not rewrite the source. Decode numeric references with `String.fromCodePoint` (DOMParser in happy-dom truncates supplementary-plane emoji). Do not render arbitrary HTML tags. Unicode emoji in the source are already literal text.
- GitHub gemoji shortcodes (`:tada:`, `:+1:`) are a Lezer `Emoji` node only when the alias is in `parse/emoji.json` (unicode gemoji, no `:octocat:` images). Preview-replace with `widget:emoji` using `cursorInside`, not line-based `nearCursor`. Typing `:` opens a dedicated completion override that inserts Unicode and replaces the `:query`; do not enable generic `autocompletion()` in `createEditor`. Do not parse inside code, after a word character (`12:00`, `hello:smi`), or as `:)` emoticons.
- Headings inside a quote fold `#` with mark-range `cursorInside`, not line-based `nearCursor`, so the title can be edited without showing the ATX marks.
- Block editing uses an **inclusive** range overlap in `blockSelected`.

The inclusive boundary is load-bearing: when the user finishes typing a closing fence, the cursor rests exactly at `node.to`. A strict (half-open) check treats that as "outside" and the widget swallows the block mid-typing, bricking the cursor at the boundary (M2 incident, root cause C). The block only renders once the cursor leaves it entirely (Typora behavior).

Test the start, inside, end-boundary, past-end, and non-empty selection cases before changing either rule.

## Engine is React-free, not DOM-free

`@omd/engine` does not depend on React or Tauri, but CodeMirror widgets call `document.createElement`, attach events, and inspect `HTMLElement`.

Engine tests run in `happy-dom`, which is **not** a complete DOM: e.g. `table.createTHead()` / `insertRow()` are missing. Prefer portable `createElement`/`appendChild` over convenience APIs. Beware: the `BlockWidget` error boundary will catch such gaps and show the fallback, which can make a broken render look like a passing test if you only assert "no exception".

A test that works with `EditorState` alone may still miss widget lifecycle and DOM behavior.

## Block decorations are illegal in ViewPlugins — and spec-only tests cannot see it

CodeMirror throws `RangeError: Block decorations may not be specified via plugins` when any `block: true` decoration (block widgets, block replaces) is provided through a `ViewPlugin` decorations facet. Block decorations change document height structure and **must** come from a `StateField` via `EditorView.decorations.from(field)`.

This was M2's most expensive bug: every document containing a table/code/math block crashed at measure time in the real app while all 57 pure-function tests stayed green, because they only asserted `collectDecorationSpecs` output and never instantiated a view.

Defense, in `packages/engine/test/view.test.ts` (keep it alive and growing):

1. Instantiate a real `EditorView` with `editorExtensions()`.
2. Route exceptions via `EditorView.exceptionSink.of(...)` and assert it stays empty.
3. Assert widget containers exist in `view.dom`.

Any new widget type must get a smoke case there before the task is considered done.

## atomicRanges: only inline replacements — never block widgets

The `atomicRanges` facet makes ranges un-enterable for cursor motion and deletion. Two rules govern what belongs there:

**Rule 1 — no `mark:`/`line:` tags.** Feeding those into the atomic set locks the user out of every styled region (arrow keys skip, Backspace refuses; M2 incident, root cause B).

**Rule 2 — no `widget:block:*` tags.** Block widgets span multiple lines. Adding them to `atomicRanges` causes two user-visible bugs:
- **↑/↓ jumps multiple lines**: when the cursor is below a code/math/table widget and the user presses Up, CodeMirror skips the entire atomic range and lands at the first line before the widget — which can be the very start of the document.
- **Right-click paste inserts extra line**: when the paste position is adjacent to a block widget boundary, CodeMirror expands the replacement range to cover the atomic unit, pulling in the next line.
Block widgets use `Decoration.replace({ block: true })`, which CodeMirror already handles for layout and cursor positioning. Atomic constraints are redundant and harmful on top.

`buildLiveDecorations` therefore emits two sets: `deco` (everything) and `atomic` (only tags starting with `replace:` or `widget:` **excluding** `widget:block:`). The `isAtomicTag` predicate enforces both rules. Never widen it without re-reading this entry.

## Right-click paste on macOS deletes extra lines (WebKit selectionchange + skipAtomsForSelection)

On macOS WKWebView (Tauri), right-clicking fires this synchronous chain **before** `contextmenu` fires:

```
mousedown (button=2)
  → CM's mousedown: setSelectionOrigin("select.pointer"), flush()
selectionchange (WebKit moves/extends native selection to the clicked line)
  → onSelectionChange → flush(false) → applyDOMChange
    → lastSelectionOrigin == "select.pointer" → skipAtomsForSelection(atomicRanges, newSel)
    → view.dispatch({ selection: expandedSel })   ← CM state is now corrupted
contextmenu fires
paste fires
  → CM's doPaste uses view.state.selection.main (the corrupted, expanded selection)
  → replaces 2 lines instead of inserting at cursor
```

The `skipAtomsForSelection` call expands the WebKit selection outward to the nearest atomic-range boundary, which can push `selection.to` past one or more newlines on empty lines.

**Fix**: in `imagePasteHandler` (`apps/desktop/src/imagePaste.ts`), a `contextmenu` handler captures `view.posAtCoords({ x, y })` (pixel coordinates are immune to native-selection state). The `paste` handler, when `contextMenuTarget` is set, dispatches its own transaction from the saved position and returns `true`, preventing CM's `doPaste` from running at all. Keyboard paste (`Ctrl/Cmd-V`) leaves `contextMenuTarget = null` and falls through to CM's default handler unchanged.

## Tests may need to force the syntax tree

Lezer parsing is incremental. Directly creating an `EditorState` does not guarantee that the full document tree is available at the point a test inspects it.

Use `packages/engine/test/helpers.ts::makeState` for parser/decoration tests that require the complete tree. It calls `ensureSyntaxTree` synchronously.

Note: production decorations are provided by a `StateField` and updated incrementally from changed ranges, selection, and syntax-tree progress. Tests that inspect a complete tree should still use `makeState`.

## Structure and appearance live in different packages

The engine emits `omd-*` class names and tests structural ranges/widgets. Desktop CSS in `apps/desktop/src/styles.css` supplies the visual result, including KaTeX CSS.

When adding or renaming a class:

1. Update the engine output.
2. Update desktop CSS in the same task.
3. Run engine tests and the desktop build.
4. Manually inspect the rendered state when appearance matters.

A passing engine test does not prove the desktop looks correct.

## Ordered list preview numbers are written back to the source

CommonMark (and Typora) display 1, 2, 3 even when the source is `1.` / `3.` / `7.`. The sequence starts at the first item's number. Live preview also rewrites those markers in the document so the cursor line matches the preview (`1.` / `2.` / `3.`). Opening a skipped-number list in live preview can therefore dirty the buffer. Source mode leaves skipped numbers alone. Do not style the raw `ListMark` text as the preview number; unselected marks still use `widget:ordered-mark`. Skip the rewrite while `view.composing` is true.

## Underscore emphasis next to CJK is not CommonMark

Lezer follows CommonMark: Han/Kana/Hangul count as letters, so `__粗体__` and `_斜体_` cannot open or close. Asterisk delimiters (`**` / `*`) still work in the same position.

`parse/cjkUnderscore.ts` intercepts underscore runs that the built-in Emphasis parser would reject and treats those scripts as punctuation. ASCII intra-word underscores (`foo_bar_`) stay literal. Do not drop that extension to "simplify" emphasis.

## Horizontal rules are block widgets when unselected

`line:omd-hr` only paints a border on top of the source markers (`---`, `***`, `* * *`, …). Live preview replaces an unselected `HorizontalRule` with `widget:block:hr`. Keep `HorizontalRule` in `SELECTION_BLOCKS` so moving the cursor onto the rule rebuilds into source.

## Async widgets can outlive their original DOM

Mermaid, Shiki, and other renderers may resolve after CodeMirror has replaced or removed a widget because the user moved the cursor or continued typing.

Check `el.isConnected` after meaningful awaits and before writing DOM. Keep errors inside the widget fallback instead of allowing rejected promises to escape into the editor.

`BlockWidget.eq` compares source text and `embed` (not `pos`). The `pos` field was removed from equality after the click handler was switched from a captured constructor offset to `view.posAtCoords`, making the captured position no longer load-bearing for correct click behavior. Removing `pos` prevents spurious Shiki/KaTeX/Mermaid re-renders when text is inserted before a widget (pos shifts, src unchanged). `embed` must stay in equality so a widget that moves into or out of a quote/list rebuilds its chrome. `ImageWidget` never included `pos` in `eq`; `BlockWidget` now follows the same rule for `pos`.

If rendering depends on an input beyond `src` (e.g., `lang` for `CodeWidget`, cell data for `TableWidget`, resolver output for `ImageWidget`), that input must still participate in the subclass `eq` override.

If output also depends on theme, resolver, or another option, include that dependency in equality or trigger an explicit rebuild.

Valid Mermaid diagrams can stall inside `mermaid.render` under `happy-dom` without producing SVG or an error. Cover success SVG with a mocked `mermaid` module; keep the real library for the invalid-syntax view test.

## Relative image source and filesystem path are different concerns

Image paste writes bytes beside the document and inserts a relative Markdown path such as `assets/pasted-....png`. The engine deliberately does not guess how that path becomes a browser-loadable URL.

`editorExtensions({ resolveImageSrc })` is the host integration point. Its default is identity. In a Tauri WebView, leaving a document-relative filesystem path unresolved can make the image load relative to the application origin rather than the Markdown file.

Keep the Markdown source relative; resolve only for preview display.

## Image paste is a two-step consistency operation

`imagePaste.ts` first calls the Rust `write_image` command, then inserts the Markdown reference. Reversing this order can leave a document pointing to a file that was never written.

The operation also requires a saved document path. It captures the path, document identity/value, and selection before asynchronous work, then passes that path to `write_image` as required `documentPath`. Paste operations for one view are serialized and revalidated before filesystem writes and editor dispatches; do not remove that queue without replacing its race guarantees. Clipboard content that is not an image must fall through to CodeMirror's default paste behavior. Local preview URLs require `allow_document_assets` for the opened/saved document directory; the static asset protocol scope stays empty.

## Window listeners can capture stale React state

Open/save shortcuts are registered once at window scope. The stable listener must call functions stored in refs so it sees the current document path and editor instance.

Adding changing React values to the listener effect can cause repeated registration; capturing them with an empty dependency array causes stale behavior.

## Tab identity and document identity are different

`EditorSession.id` is the stable tab key (one `EditorView` / host per tab). `documentId` increments when a file is opened or reloaded so in-flight image paste and save operations can detect a stale session. Do not increment `id` on open: React would remount the host and destroy undo history.

Cmd+O replaces the active tab. File-tree / search open in a new tab, or focus an existing tab with the same path. Switching tabs hides hosts; do not stuff multiple documents into one `EditorState`. The Files sidebar is always mounted; opening a file also `ensureFolder`s its parent so the tree is not gated on an explicit Open folder command. Expanding a directory lists that folder in place and must not replace `workspace.folder`. Open / Open Folder / Save / Export live in the native File menu and Cmd+K, not in a chrome export panel.

Autosave (about 1.5s, pathed documents only) and Cmd+S share the same save queue. Untitled buffers go to recovery files only. Startup recovery must prompt; never silently overwrite. External file changes poll `read_file`: clean tabs reload, dirty tabs ask. StatusBar path + dirty ` •` must stay one text node so session tests can `getByText` the exact path.

## Dirty state needs a saved-content baseline

`App.tsx` receives every document change through `EditorView.updateListener` and compares the current text with the last successfully opened or saved snapshot. A one-way boolean ("a change happened") is insufficient because undo can return to the clean baseline.

Opening a document creates a new `EditorState` after synchronizing its path. This both resets undo history and lets relative-image resolution use the correct path during the first decoration build. Save completion may update the clean baseline only for the same document session; edits made during a pending save must remain dirty.

## Lezer has runtime-only internals missing from the typings

`Line.depth` and `BlockContext.stack` exist at runtime (the built-in parsers use them) but are absent from `@lezer/markdown`'s public type declarations. `vitest run` does not typecheck, so such misuse passes tests and only explodes under `tsc --noEmit` (which `pnpm --filter @omd/engine test` now runs first) or the stricter desktop tsconfig (`noUnusedLocals` etc., which also typechecks engine sources through the workspace import).

Pattern used in `parse/footnotes.ts` and `parse/math.ts`: cast `(line as unknown as { depth: number }).depth`, and prefer the public equivalent when one exists (`cx.depth` === internal `stack.length`). Always leave a comment on the cast.

## Manual QA baselines can become stale

`docs/manual-qa.md` is valuable for IME, undo/redo, scrolling, and file workflows, but embedded test counts and milestone labels are snapshots of the time they were written.

Treat its interaction checklist as guidance and obtain current automated counts from command output. Update the document when supported behavior changes.
