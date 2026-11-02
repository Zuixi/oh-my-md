# Engine Parsing & Markdown Dialect

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Lezer Markdown configuration, custom inline/block syntax extensions, character constants, and verbatim predicates (`src/parse/**`).

## Parser Rules

- **Single parser architecture (`markdown.ts`):** Extend `@lezer/markdown` via `markdownLanguageSupport()`. Never introduce a second document-level Markdown parser.
- **Never force full-document parses in production:** Steady-state CodeMirror parses only up to the viewport margin (`Work.MaxParseAhead`). Never call `ensureSyntaxTree(state, state.doc.length)` or `forceParsing` in production code (`apps/desktop/test/crossLayerNoFullTree.test.ts` guards this; see `gotchas-engine.md`).
- **Named character codes (`chars.ts`):** Always use `CHAR_*` constants (`CHAR_BACKSLASH`, `CHAR_UNDERSCORE`, `CHAR_DOLLAR`, …) when inspecting `cx.char(i)` — never bare numeric literals.
- **Escape & inline-code boundaries (`scan.ts`):** Preserve each extension's opener/closer escape and code-span behavior; reuse `isEscaped`/`skipInlineCode` where explicit scanning needs them instead of inventing a second policy. Check the relevant Lezer node-shape tests and Smart Paste's `MarkdownTriggerPolicy` when changing syntax.

## Dialect Specifics

- **Single verbatim predicate (`verbatim.ts`):** `inVerbatim(state, pos)` (covering `InlineCode`, `FencedCode`, `CodeBlock`, `InlineMath`, `MathBlock`, `FrontMatter`, and returning `true` when the syntax tree has not reached `pos + 1`) is the single source of truth for raw-text regions (used by Smart Paste, auto-pair, and emoji completion).
- **CJK underscore flanking (`cjkUnderscore.ts`):** Treats Han/Hiragana/Katakana/Hangul as punctuation for `_` / `__` flanking so `__粗体__` works while ASCII intra-word `foo_bar_` stays literal.
- **Front matter vs HR (`frontMatter.ts`):** Leading `---` at line 1 opens a `FrontMatter` block (unclosed swallows to EOF, matching `MathBlock`).
- **Entities & Emoji (`entities.ts`, `emoji.ts`, `emojiComplete.ts`):** Decode numeric HTML entities with `String.fromCodePoint`. Emoji `:alias:` nodes resolve only known `emoji.json` aliases and never trigger inside code or after word characters (`12:00`).
- **Table cells (`cell.ts`):** `parseCell` is shared by Live Preview and HTML exports; also read [the table contracts](../tables/AGENTS.md) when changing it.

## Verification

- Follow [engine verification](../../AGENTS.md#testing), including desktop cross-layer guards. Cover parser node shapes, escaped delimiters, and code-span boundaries; table-cell changes must exercise both rendered and export consumers.
