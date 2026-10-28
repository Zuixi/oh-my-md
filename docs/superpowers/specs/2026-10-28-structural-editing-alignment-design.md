# Structural Editing Alignment Design

## Status

Approved in chat on 2026-10-28. This design covers fenced-code paired-brace
newline behavior, table boundary navigation, and nested-list structural editing.
Typora-style direct table-cell editing is explicitly deferred to a separate
throwaway spike.

## Problem

OMD has three independent structural-editing state machines:

- fenced-code auto-pairing and Enter indentation;
- table cell navigation and row creation;
- list continuation and indentation.

Each behaves correctly according to its local rules, but those rules do not
compose into a consistent editor experience:

- `{|}` + Enter leaves the auto-paired `}` on the indented content line;
- Enter on the final table row appends forever;
- list commands use a regex and a fixed two-space indent while rendering and
  quote handling already use Lezer-derived structure.

## Architecture

Keep the existing engine ownership boundary and separate pure transaction
modules. Do not create a global structural-editing router.

Every command remains:

```ts
(state: EditorState) => TransactionSpec | null
```

with dispatch isolated in the existing read-only-aware command wrappers.
Structural decisions come from the current document, selection, and Lezer tree;
no module-global or per-view editing state is added.

## Fenced Code Contract

When the caret is in fenced-code content and exactly between an auto-paired
`{}`:

```text
base{|}
```

Enter produces:

```text
base{
base··|
base}
```

where `base` is the current content indentation and `··` is the existing
two-space code indent unit. The closing brace is preserved, not reinserted.
Quoted fences repeat their structural prefix on both inserted lines.

All other code-line Enter behavior remains unchanged, including terminal blank
line exit, ordinary indentation inheritance, and opening-token indentation when
there is no adjacent matching closer.

## Table Contract

- Tab: next cell; from the final cell, append one row.
- Shift-Tab: previous cell.
- Enter: same column in the next row; from the final row, exit to the blank
  paragraph after the table.
- Shift-Enter: same column in the previous row.
- Mod-Enter: explicit exit, unchanged.

Plain Enter must never fall through to a raw newline inside GFM table source.
The two-state table model remains: rendered widget while unfocused, Markdown
source grid while selected.

## List Contract

List editing must use Lezer structure and the shared block-prefix model rather
than a line regex.

- Non-empty item Enter continues the current innermost list level.
- Ordered markers increment; task markers reset to `[ ]`.
- Empty nested item Enter steps out exactly one list level.
- Empty top-level item Enter exits the list while preserving enclosing quotes.
- Tab indents under the previous sibling item and uses that parent's real
  content column; without a previous sibling it yields without mutation.
- Shift-Tab removes one real list nesting level.
- Quote/list/task ordering and source spacing are preserved.
- The engine list keymap owns Enter/Tab/Shift-Tab deterministically at
  `Prec.highest`.
- Valid visual nesting is not clamped at depth four. The engine emits a numeric
  CSS custom property for depth; desktop CSS derives padding from it.

If the syntax tree does not cover the relevant line or ancestry, commands return
`null` rather than guessing structure.

## Non-goals

- No LSP, language server, or full code formatter.
- No stock `closeBrackets`, `indentOnInput`, or second desktop pairing layer.
- No direct rendered table-cell editor in this implementation.
- No whole-table serialization or second Markdown parser.
- No multi-line/multi-cursor list indentation in this milestone.

## Verification

Each behavior requires a test-first red/green cycle with:

- pure transaction tests for exact document and selection output;
- real `EditorView` keymap ownership tests;
- focused Playwright coverage for code pairing and table navigation;
- full engine tests, desktop tests/build for cross-layer CSS changes, and
  `git diff --check`.

