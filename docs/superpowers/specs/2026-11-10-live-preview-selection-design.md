# Live Preview Selection and Markdown Copy Design

## Decision

Selections across live preview copy the exact Markdown source in the selected document range. Selection endpoints are CodeMirror document offsets, including inside rendered code and tables. Visual projection must not obscure selected text or substitute DOM text for source bytes. Plain paragraph, list, and quote selection continues to use CodeMirror's native selection model.

## Current failures

1. `blockSelectionOverlay.ts` adds `omd-block-covered` when a selection completely covers a replace widget. `styles.css` paints its opaque `::after` over the widget text. Browser reproduction: select from an introductory paragraph through a code block and table; code text and table body text disappear, while `state.doc` and clipboard contents remain intact.
2. Dragging inside `CodeWidget` creates a browser DOM selection but leaves `EditorState.selection` at the previous caret. Browser reproduction: DOM selection reads `onst sel`, Cmd+C copies `end`.
3. `TableWidget.nativePointerInteraction` opens an input on `mousedown`, preventing a text drag in a rendered cell. Browser reproduction: dragging `cell` opens `.omd-table-cell-input` and produces no document selection.

CodeMirror's `Decoration.replace` hides a source range behind widget DOM. Its selection facet can customize pointer selection, but a block widget's DOM characters do not automatically map to source offsets. The host's `tightSelection` draws document selection; do not add stock `drawSelection` or make block replacements atomic.

## Interaction contract

| Gesture | Result |
| --- | --- |
| Drag across ordinary lines and fully covered blocks | One CodeMirror range; visible block content stays readable (`.omd-block-covered`); copy is `doc.sliceString(from, to)` |
| Drag a subset of rendered fenced code (or drag into it from outside) | Keeps `CodeWidget` mounted, maps endpoints to source offsets, paints `.omd-widget-selected-text` over selected glyphs; copying returns exact source bytes |
| Click rendered code | Enters the numbered source editing state (`codeEditingField` + `styleEditingCodeblock`) without changing bytes |
| Click a rendered table cell | Opens its existing direct-edit session (double-click selects word, triple-click selects cell, keyboard selections paint `.omd-table-cell-selected`) |
| Drag over table text (or drag into it / Shift+Click from outside) | Closes any active cell input, keeps `TableWidget` mounted, maps endpoints to source offsets, and paints `.omd-widget-selected-text` over selected glyphs; copy returns exact source bytes including markup. Explicit source editing stays on the `</>` button |
| Select all / Shift+navigation / source mode | Existing CodeMirror selection and Markdown copy behavior |

Click and drag resolve to different interaction modes, while the resulting copy range always lives in `EditorState.selection`. Both `TableWidget` and `CodeWidget` implement `BlockWidget.sourceOffsetAtPoint` and `BlockWidget.selectionRects` so partial selections stay rendered and paint per-glyph highlights via `blockWidgetSelectionExtension` (`blockSelectionLayer.ts`) instead of flipping the block into Markdown source rows. A table press opens its cell input immediately; once pointer movement establishes a drag, that session closes cleanly without revealing source rows or changing document bytes. If a rendered projection cannot provide exact source offsets (for example, a synthesized missing table cell or padding gap), hold the previous valid head or leave the selection unchanged when there is no source slot; do not invent text or silently copy an unrelated caret. Keep accessibility and read-only selection working.

## Delivery and acceptance

1. Repair the covered block's visual layer and test readability in a real browser in both themes for code, GFM table, and nested quote/list cases.
2. Route code-body pointer drags to a source-backed editor selection; retain the current click-to-edit behavior. Test partial selection, cross-block drag, reverse drag, multiline/empty lines, quoted fences, pre-highlight placeholder and highlighted output, clipboard bytes, and no document change.
3. Distinguish table click from drag, map drag to a source-backed selection, and preserve the cell edit session and tools on a click. Test partial cell and cross-cell/block gestures, escaped pipes, inline markup, noncanonical tables, missing cells, reverse direction, and clipboard bytes.
4. Run engine, desktop, build, real-browser, and module-size gates; update `docs/manual-qa.md`. Review every worker task's diff and observed behavior before dispatching the next. Open a PR, wait for required CI, and merge only after review and green checks.

The current clipboard default already copies Markdown for CodeMirror ranges; the new work must make the gesture's visible range and document range agree. Avoid a parallel native-selection clipboard path for widgets.
