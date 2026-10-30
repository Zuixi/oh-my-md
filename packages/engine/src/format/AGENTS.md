# Engine Formatting & Keymaps

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Markdown editing commands, structural `Enter`/`Tab`/`Backspace` keymaps, tree-driven block prefixes, and auto-pairing (`src/format/**`).

## Keymap Precedence & Ownership Chain

Desktop registers `defaultKeymap` before `editorExtensions()`, and `@codemirror/lang-markdown`'s `markdown()` registers its own `Prec.high` `Enter` (`insertNewlineContinueMarkup`) and `Backspace` (`deleteMarkupBackward`) first.

- **All structural `Enter`, `Tab`/`Shift-Tab`, and empty top-level list `Backspace` bindings must use `Prec.highest`.** `Prec.high` is only sufficient where nothing upstream competes (`autoPair` Backspace, `blockMotionKeymap`, `caretClampKeymap`).
- **Registration & fallthrough order in `editorExtensions()`:**
  `tableKeymap` → `codeLineKeymap` → `codeIndentKeymap` → `fenceKeymap` → `quoteKeymap` → `listKeymap`.
- **Mutual exclusion (`test/enter-ownership.test.ts`, `test/tableKeymapWiring.test.ts`):**
  - `tableKeymap` claims `Tab` / `Shift-Tab` / `Enter` / `Shift-Enter` / `Mod-Enter` **only** inside a `Table` node (or `unresolvedTableRowSpec` for `Tab`/`Shift-Tab` when the syntax tree has not yet reached a pipe row).
  - `continueCodeLine` claims non-fence content lines inside `FencedCode` (exits after closing fence on final blank line; copies block prefix + content indent; expands `{|}` into three lines keeping existing `}`).
  - `continueFence` (`fences.ts`) completes an unclosed fence (single `CodeMark` child, never `node.to > line.to`) at line end, repeating any quote prefix (`> ```js`), and refuses inside list items.
  - `continueQuote` (`quotes.ts`) claims lines whose innermost non-task mark (`blockPrefix.ts::enterOwnerMark`) is `quote`.
  - `continueList` (`lists.ts`) claims lines whose innermost non-task mark is `list` (continues non-empty item, steps out one level on empty nested item, exits on empty top-level item). List `Tab`/`Shift-Tab` must still consume the key when its pure spec returns `null` so browser focus does not leave the editor.

## Tree-Driven Block Prefixes (`blockPrefix.ts`)

- **Use the available tree, not prefix regexes or fixed indentation.** Extract structure via `blockPrefixOf`, `listFrameAt`, `itemMarkAt`, and `listContentColumn`. The approved exception is `tableKeymap.ts::unresolvedTableRowSpec`: when the tree is unavailable, its conservative shape check consumes Tab without editing; do not expand it into a second parser.
- **CommonMark visual columns:** List indentation uses visual columns (tab stops every 4 columns; marker content column = marker end + 1–4 spaces, fallback 1 column).
- **Mark removal (`markRemovalRange`):** Removing a quote mark deletes `>` plus **at most one** following space; remaining whitespace is content indentation.
- **Quote toggling (`commands.ts::toggleQuoteSpec`):** All-or-nothing across selected lines (if all quoted → unquote all; otherwise quote only unquoted lines).
- **Caret clamping (`navigation/caretClamp.ts`):** Clamp pointer mousedown, `Home`/`Shift-Home`, and `ArrowUp`/`ArrowDown` out of folded prefixes to `lineContentStart`.

## Explicit Selection & Shortcut Single Source

- **Explicit `selection` on every continuation spec:** Set `selection: { anchor: insertStart + insert.length }` explicitly; otherwise CodeMirror maps a collapsed caret with `assoc = -1` and leaves it on the previous line.
- **Shortcut derivation (`commands.ts`):** Define `id`, `key`, `display`, and `run` in `markdownKeyBindings`. Never duplicate shortcut strings in desktop menus or palettes (`test/shortcuts.test.ts` guards `key` ↔ `display`).
- **Auto-pairing (`autoPair.ts`):** Owns the three hot-swappable toggles (`setAutoPair` via `autoPairCompartment`). Never enable stock `@codemirror/autocomplete` `closeBrackets`.

## Related Guides & Verification

- For `tableKeymap.ts`, also read [the table contracts](../tables/AGENTS.md); table navigation crosses this directory boundary.
- Follow [engine verification](../../AGENTS.md#testing). Exercise ownership/fallthrough with the assembled extension order (`enter-ownership.test.ts`, `tableKeymapWiring.test.ts`), explicit caret placement, and read-only guards.
