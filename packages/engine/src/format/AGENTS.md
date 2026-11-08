# Engine Formatting & Keymaps

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Markdown editing commands, structural `Enter`/`Tab`/`Backspace` keymaps, tree-driven block prefixes, and auto-pairing (`src/format/**`).

## Keymap Precedence & Ownership Chain

Desktop registers `defaultKeymap` before `editorExtensions()`, and `@codemirror/lang-markdown`'s `markdown()` registers its own `Prec.high` `Enter` (`insertNewlineContinueMarkup`) and `Backspace` (`deleteMarkupBackward`) first.

- **Formatting bindings use `Prec.high`:** `markdownKeymap` must outrank the host's earlier `defaultKeymap` for collisions such as `Mod-i` and `Mod-Shift-k`. Do not lower it to default precedence.
- **All structural `Enter`, `Tab`/`Shift-Tab`, and empty top-level list `Backspace` bindings must use `Prec.highest`.** `Prec.high` is only sufficient where nothing upstream competes (`autoPair` Backspace, `blockMotionKeymap`, `caretClampKeymap`).
- **Registration & fallthrough order in `editorExtensions()`:**
  `tableKeymap` → `codeLineKeymap` → `codeIndentKeymap` → `fenceKeymap` → `quoteKeymap` → `listKeymap`.
- **Mutual exclusion (`test/enter-ownership.test.ts`, `test/tableKeymapWiring.test.ts`):**
  - `tableKeymap` claims `Tab` / `Shift-Tab` / `Enter` / `Shift-Enter` / `Mod-Enter` **only** inside a `Table` node (or `unresolvedTableRowSpec` for `Tab`/`Shift-Tab` when the syntax tree has not yet reached a pipe row).
  - `continueCodeLine` claims non-fence content lines inside `FencedCode` (exits after closing fence on final blank line; copies block prefix + content indent; expands `{|}` into three lines keeping existing `}`).
  - `continueFence` (`fences.ts`) completes an unclosed fence (single `CodeMark` child, never `node.to > line.to`) at line end, repeating any quote prefix (`> ```js`), and refuses inside list items.
  - `continueQuote` (`quotes.ts`) claims lines whose innermost non-task mark (`blockPrefix.ts::enterOwnerMark`) is `quote`.
  - `continueList` (`lists.ts`) claims lines whose innermost non-task mark is `list` (continues non-empty item, steps out one level on empty nested item, exits on empty top-level item). List `Tab`/`Shift-Tab` must still consume the key when its pure spec returns `null` so browser focus does not leave the editor.

## Formatting Commands

- **Inline formats are independent semantic dimensions:** Bold/italic may combine (`**` + `*` → `***`, including underscore forms); underline uses asymmetric `<u>` / `</u>` markers. Adding a different non-code format wraps a locally proved whole inline node, which is the only approved way to add formatting around `InlineCode`; pressing the same dimension removes it. Never append a second same-kind wrapper such as `****text****`.
- **Dispatcher only (`commands.ts`):** Own the `Command` wrapper, read-only rejection, keymap order, and public exports. Marker planning belongs in `inlineCommands.ts`, `blockCommands.ts`, `codeBlockCommands.ts`, or `linkCommand.ts`; shared tree/selection primitives belong in `semantics.ts`.
- **Pure all-or-nothing specs:** Every planner returns `EditorState → TransactionSpec | null` and never dispatches. A `null` result must leave the document untouched; never construct a partial transaction and then abandon it.
- **Semantic toggles, not marker insertion:** Repeated shortcuts converge on the target state (`all target → remove` / `otherwise → normalize every selected line or replace the whole inline node`). Never append another delimiter pair or toggle selected lines independently. The user-visible contract is one transaction and one undo step per successful press; `commands.ts` annotates `input.format` and `isolateHistory.of("full")` so adjacent typing or another format command cannot merge into it.
- **Wrapping keeps the caret inside the new syntax:** Inline and fenced-code wraps must build the resulting selection explicitly. A collapsed caret at a word/paragraph end must stay before the closing delimiter; right-biased mapping would place it after the closing insertion, and the next press would stack a second wrapper instead of toggling it off.
- **Repeat plans are revocable local facts (`inlineCommands.ts::inlinePlanState`):** Mount the field at the top level of `editorExtensions()`. Only inline format transactions may publish the content range/marker they just created or removed; every other document-changing transaction (typing, undo, widget edits) clears it. The fallback must revalidate selection ownership and exact source delimiters/flanking before use, and must never become a general raw-marker parser.
- **Fail closed on unsafe structure:** Refuse inline edits across paragraphs/verbatim/partial syntax nodes, and block edits inside fenced/indented code, math, front matter, tables, or other irreversible hosts. Do not insert a raw marker pair unless the result can be reparsed as the requested node and toggled back.
- **Tree coverage is proportional to the available proof:** Commands without a local semantic proof use `syntaxTreeAvailable(state, end)`, never `syntaxTree(state).length`. Fresh inline wrapping requires a resolved local inline container plus verbatim/partial-node rejection; unwrapping additionally requires the exact semantic node and two valid delimiters. This avoids blocking an edit because an unrelated earlier fragment hole exists. Production code must not force parsing to make a command succeed; an unproved operation stays a no-op.

## Tree-Driven Block Prefixes (`blockPrefix.ts`)

- **Use the available tree, not prefix regexes or fixed indentation.** Extract structure via `blockPrefixOf`, `listFrameAt`, `itemMarkAt`, and `listContentColumn`. The approved exception is `tableKeymap.ts::unresolvedTableRowSpec`: when the tree is unavailable, its conservative shape check consumes Tab without editing; do not expand it into a second parser.
- **CommonMark visual columns:** List indentation uses visual columns (tab stops every 4 columns; marker content column = marker end + 1–4 spaces, fallback 1 column).
- **Mark removal (`markRemovalRange`):** Removing a quote mark deletes `>` plus **at most one** following space; remaining whitespace is content indentation.
- **Quote toggling (`blockCommands.ts::toggleQuoteSpec`):** All-or-nothing across selected lines (if all quoted → unquote all; otherwise quote only unquoted lines).
- **Caret clamping (`navigation/caretClamp.ts`):** Clamp pointer mousedown, `Home`/`Shift-Home`, and `ArrowUp`/`ArrowDown` out of folded prefixes to `lineContentStart`.

## Explicit Selection & Shortcut Single Source

- **Explicit `selection` on every continuation spec:** Set `selection: { anchor: insertStart + insert.length }` explicitly; otherwise CodeMirror maps a collapsed caret with `assoc = -1` and leaves it on the previous line.
- **Shortcut derivation (`commands.ts`):** Define `id`, `key`, `display`, and `run` in `markdownKeyBindings`. Never duplicate shortcut strings in desktop menus or palettes (`test/shortcuts.test.ts` guards `key` ↔ `display`).
- **Auto-pairing (`autoPair.ts`):** Owns the three hot-swappable toggles (`setAutoPair` via `autoPairCompartment`). Never enable stock `@codemirror/autocomplete` `closeBrackets`.

## Related Guides & Verification

- For `tableKeymap.ts`, also read [the table contracts](../tables/AGENTS.md); table navigation crosses this directory boundary.
- Follow [engine verification](../../AGENTS.md#testing). Exercise ownership/fallthrough with the assembled extension order (`enter-ownership.test.ts`, `tableKeymapWiring.test.ts`), formatting through a mounted `EditorView` (`formatView.test.ts`) for keymap precedence and history grouping, and incomplete-tree fail-closed behavior with a detached state (`formatInline.test.ts`).
