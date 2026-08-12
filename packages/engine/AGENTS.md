# Engine Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
>
> **Scope:** Markdown parsing, CodeMirror live-preview state, decorations, block widgets, and engine tests. The package is framework-independent but browser-DOM-aware.

## Read This When

- You are changing `packages/engine/src/**` or `packages/engine/test/**`.
- You are adding or changing Markdown syntax, folded markers, widgets, or live/source behavior.
- A rendering defect appears to come from the syntax tree or decoration ranges rather than CSS.

## Local Structure

```text
packages/engine/
├── src/
│   ├── index.ts                 # Public editorExtensions(options) entrypoint
│   ├── parse/                   # Lezer Markdown, math, and footnote extensions
│   ├── modes/livePreview.ts     # Live/source compartment and Mod-e keymap
│   └── decorations/
│       ├── build.ts             # Viewport decoration collection and plugin
│       ├── inline.ts            # Inline and marker decorations
│       ├── blocks.ts            # Block detection and widget selection
│       ├── blockWidget.ts       # Shared widget lifecycle and edit transition
│       └── widgets/             # Code, math, table, Mermaid, and image renderers
├── test/                        # Vitest tests
└── test/fixtures/               # Markdown regression inputs
```

## Domain Boundaries

1. Keep Markdown syntax knowledge, Lezer tree inspection, and Markdown-specific CodeMirror decorations in this package.
2. Do not import React, Tauri APIs, desktop modules, or native filesystem APIs.
3. DOM use is allowed inside CodeMirror widgets. Keep it localized and compatible with the `happy-dom` test environment.
4. The engine emits semantic `omd-*` class names; visual declarations belong in `apps/desktop/src/styles.css`.
5. Expose desktop-facing behavior through `src/index.ts`, preferably via `editorExtensions(options)`. Do not make desktop consumers assemble engine internals.
6. Keep generic host choices such as editor dimensions, base typography, history, and non-Markdown keymaps in `apps/desktop/src/Editor.ts`.

## Decoration and Widget Invariants

1. Decorations must be sorted and non-overlapping where CodeMirror requires it.
2. When a block widget replaces a syntax node, skip that node's subtree and filter enclosed outer decorations; overlapping replace ranges can make `Decoration.set` throw.
3. Rebuild live decorations when the document, viewport, or selection changes. Rendering should remain viewport-scoped.
4. Preserve the source document. A preview widget renders a projection and enters editing mode by moving selection into the source range.
5. Treat a block as editable when the selection overlaps its half-open `[from, to)` range. Do not replace selected source with a widget.
6. `BlockWidget.eq` is source-based. If rendering also depends on another input, that input must participate in widget equality or trigger a safe rebuild.
7. Async widget failures must be contained inside the widget and display actionable fallback content; they must not reject into the editor lifecycle.
8. Image paths are resolved through the `EngineOptions.resolveImageSrc` host callback. The engine must not assume Tauri file URLs.

## Parsing Rules

- Extend Lezer Markdown instead of introducing a second Markdown parser.
- Preserve existing syntax limitations unless the task explicitly changes them; encode intentional limitations in tests.
- Keep format-specific parsing in `parse/` and rendering decisions in `decorations/`.
- Check child and parent node behavior when adding rules; block replacements can suppress inline decorations by design.

## Testing

Run:

```sh
pnpm test
```

- `pnpm test` performs `tsc --noEmit` and then runs Vitest.
- Use `test/helpers.ts::makeState` when tests require a fully available syntax tree; it forces synchronous parsing with `ensureSyntaxTree`.
- Add focused tests for parser node shapes, decoration tags/ranges, widget editing state, and live/source round trips.
- Add a fixture when a Markdown sample is useful across snapshot or regression tests. Keep fixtures deterministic and small unless testing large-document behavior.
- Async widgets require explicit timing/error assertions; do not rely on incidental microtask completion.
- For changes affecting appearance or interaction, also build the desktop frontend and perform the relevant items in `docs/manual-qa.md`.

## Common Pitfalls

- A correct parser node does not guarantee a valid decoration set; inspect overlaps and ordering separately.
- Cursor proximity and selection are part of rendering state. Test both collapsed cursors and non-empty selections.
- CodeMirror widgets create real DOM even though the package has no React dependency.
- CSS regressions cannot usually be fixed in this package because engine tests assert structure and ranges, not final desktop appearance.
- Mermaid, Shiki, and KaTeX may render asynchronously or throw on invalid source; preserve the original Markdown in error output.
- Do not add `indentOnInput`, `closeBrackets`, or `autocompletion` to compensate for preview behavior. Fix the underlying parse/decoration interaction.

## Documentation Maintenance

Before concluding engine work, check:

- [ ] Did public engine options or exports change?
- [ ] Did a parser or widget invariant change?
- [ ] Does a new regression belong in `docs/memory/known-gotchas.md`?
- [ ] Do fixtures, snapshots, or `docs/manual-qa.md` need updating?
- [ ] Did an approved architecture decision in the product spec change?
