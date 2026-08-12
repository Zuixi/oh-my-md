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

Boundary positions are intentionally different:

- Inline folding uses a line-based `nearCursor` check.
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

## atomicRanges accepts only replace-type decorations

The `atomicRanges` facet makes ranges un-enterable for cursor motion and deletion. Feeding it the whole decoration set — including `mark:` decorations like `omd-link`/`omd-strong` that cover editable text — locks the user out of every styled region (arrow keys skip, Backspace refuses; M2 incident, root cause B).

`buildLiveDecorations` therefore emits two sets: `deco` (everything) and `atomic` (only tags starting with `replace:` or `widget:`). Never let `mark:`/`line:` tags into the atomic set. Inline folded marks are additionally protected by the line-based `nearCursor` unfold, so atomicity is redundant for them — it exists for block widgets and off-line folds.

## Tests may need to force the syntax tree

Lezer parsing is incremental. Directly creating an `EditorState` does not guarantee that the full document tree is available at the point a test inspects it.

Use `packages/engine/test/helpers.ts::makeState` for parser/decoration tests that require the complete tree. It calls `ensureSyntaxTree` synchronously.

Note: production decorations are computed whole-document inside a `StateField` (viewport culling is incompatible with field-provided block decorations, and block heights must be known at state time). This is acceptable at current document sizes; revisit with dirty-range increments only if profiling says so.

## Structure and appearance live in different packages

The engine emits `omd-*` class names and tests structural ranges/widgets. Desktop CSS in `apps/desktop/src/styles.css` supplies the visual result, including KaTeX CSS.

When adding or renaming a class:

1. Update the engine output.
2. Update desktop CSS in the same task.
3. Run engine tests and the desktop build.
4. Manually inspect the rendered state when appearance matters.

A passing engine test does not prove the desktop looks correct.

## Async widgets can outlive their original DOM

Mermaid, Shiki, and other renderers may resolve after CodeMirror has replaced or removed a widget because the user moved the cursor or continued typing.

Check `el.isConnected` after meaningful awaits and before writing DOM. Keep errors inside the widget fallback instead of allowing rejected promises to escape into the editor.

`BlockWidget.eq` currently compares source text. If output depends on theme, resolver, or another option, include that dependency in equality or trigger an explicit rebuild.

## Relative image source and filesystem path are different concerns

Image paste writes bytes beside the document and inserts a relative Markdown path such as `assets/pasted-....png`. The engine deliberately does not guess how that path becomes a browser-loadable URL.

`editorExtensions({ resolveImageSrc })` is the host integration point. Its default is identity. In a Tauri WebView, leaving a document-relative filesystem path unresolved can make the image load relative to the application origin rather than the Markdown file.

Keep the Markdown source relative; resolve only for preview display.

## Image paste is a two-step consistency operation

`imagePaste.ts` first calls the Rust `write_image` command, then inserts the Markdown reference. Reversing this order can leave a document pointing to a file that was never written.

The operation also requires a saved document path. Clipboard content that is not an image must fall through to CodeMirror's default paste behavior.

## Window listeners can capture stale React state

Open/save shortcuts are registered once at window scope. The stable listener must call functions stored in refs so it sees the current document path and editor instance.

Adding changing React values to the listener effect can cause repeated registration; capturing them with an empty dependency array causes stale behavior.

## Dirty state is not yet transaction-driven

`App.tsx` currently marks the document dirty from a DOM `input` listener. Programmatic CodeMirror transactions are not guaranteed to have the same semantics as user DOM input.

When adding commands that modify the document programmatically, verify dirty-state behavior explicitly. A future migration to `EditorView.updateListener` should distinguish content changes from selection-only transactions.

## Lezer has runtime-only internals missing from the typings

`Line.depth` and `BlockContext.stack` exist at runtime (the built-in parsers use them) but are absent from `@lezer/markdown`'s public type declarations. `vitest run` does not typecheck, so such misuse passes tests and only explodes under `tsc --noEmit` (which `pnpm --filter @omd/engine test` now runs first) or the stricter desktop tsconfig (`noUnusedLocals` etc., which also typechecks engine sources through the workspace import).

Pattern used in `parse/footnotes.ts` and `parse/math.ts`: cast `(line as unknown as { depth: number }).depth`, and prefer the public equivalent when one exists (`cx.depth` === internal `stack.length`). Always leave a comment on the cast.

## Manual QA baselines can become stale

`docs/manual-qa.md` is valuable for IME, undo/redo, scrolling, and file workflows, but embedded test counts and milestone labels are snapshots of the time they were written.

Treat its interaction checklist as guidance and obtain current automated counts from command output. Update the document when supported behavior changes.
