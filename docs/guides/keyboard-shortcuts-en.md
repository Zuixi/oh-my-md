# Keyboard Shortcuts Guide

> [English](./keyboard-shortcuts-en.md) · [简体中文](./keyboard-shortcuts.md)

oh-my-md shortcuts are organized in two layers: **Editor formatting shortcuts** (active when focus is in the editor, provided by the engine's `markdownKeymap`) and **App-level shortcuts** (handled by the window and command palette). Every formatting command is also available in the Command Palette (`⇧⌘P`), so you never have to memorize a binding.

> **Platform note:** Shortcuts below use macOS symbols (`⌘` / `⌥`). On Windows and Linux, `⌘` maps to `Ctrl` and `⌥` maps to `Alt`.

## Editor Formatting Shortcuts

Trigger at the caret or over a selection. Every command is a **semantic toggle**: pressing the same shortcut twice switches between the target format and plain text — it never stacks duplicate delimiters. Each successful press is a single transaction and an isolated undo step.

When the current syntax context cannot be rewritten safely (for example, an inline selection spanning across code/math/paragraphs, a partial syntax node, or a block command inside a table), the command fails closed and leaves the document untouched. Mixed multi-line block selections normalize all lines to the target state first instead of flipping lines independently.

### Inline Formatting

| Shortcut | Action | Behavior |
| --- | --- | --- |
| `⌘B` | Bold | Wraps `**text**` |
| `⌘I` | Italic | Wraps `*text*` |
| `⌘U` | Underline | Wraps `<u>text</u>` |
| `⇧⌘X` | Strikethrough | Wraps `~~text~~` |
| `` ⌘` `` | Inline code | Wraps `` `code` `` (auto-expands backtick fence if content contains backticks; `` ⇧⌘` `` is also bound) |

- **Caret inside or at a word boundary** (no selection): applies to the current word and keeps the caret inside the closing marker.
- **With selection**: applies to the selected text and keeps it selected for chaining (`⌘B` then `⌘I` → `***text***`).
- **Pressing the same key again**: removes only that semantic layer (e.g. toggling bold on `***text***` leaves `*text*`).
- **Composing around inline code**: adding bold/italic on a resolved inline-code node wraps the whole node (`` **`code`** ``) instead of injecting markers inside the code.

### Headings

| Shortcut | Action |
| --- | --- |
| `⌘1` – `⌘6` | Set heading level 1–6 / press the same level again to clear |

- Applies to the current line, or every line in a multi-line selection.
- Switching from another heading level replaces `#` cleanly without stacking.

### Lists & Blockquotes

| Shortcut | Action |
| --- | --- |
| `⌥⌘7` | Ordered list |
| `⌥⌘8` | Bullet list |
| `⌥⌘9` | Blockquote |
| `Enter` (in list item) | Continue same list type; empty nested item outdents one level; empty top-level item exits list |
| `Tab` / `Shift-Tab` (in list item) | Indent / outdent following CommonMark container columns |

- Ordered lists number sequentially (`1. 2. 3.`) and continue numbering when adjacent to an existing ordered list.
- Switching between bullet and ordered lists replaces markers cleanly (`- ` ↔ `1. `).
- Lists inside blockquotes preserve the enclosing `> ` prefix on continuation.

### Code Blocks & Links

| Shortcut | Action |
| --- | --- |
| `⇧⌘K` | Code block: wraps selection (or current paragraph) in ` ``` ` fences; toggles off when inside or covering a fenced block |
| `⌘K` | Insert / edit link |

Code-block toggling runs only in reversible top-level contexts (no-ops inside quotes, lists, math, front matter, or tables).

Insert link (`⌘K`) behavior:
- **Selected URL** (`http://` / `https://` / `www.`): creates `[url](url)` with the label selected.
- **Selected text**: creates `[text](` with the caret inside the parentheses.
- **Caret on a word**: uses that word as the link text and places the caret in `()`.
- **Caret inside an existing link**: selects its URL without double-wrapping.
- **Entire existing link selected**: unlinks back to its visible text.
- **Caret inside a bare URL**: expands to the full URL and wraps it once.

## App-Level Shortcuts

| Shortcut | Action |
| --- | --- |
| `⇧⌘P` | Command Palette |
| `⌘P` | Quick Open file |
| `⌘,` | Open Settings |
| `⌘\` | Toggle Sidebar |
| `⌘F` | Find in current document |
| `⌘H` | Find and Replace in current document |
| `⌘G` / `Enter` (in Find) | Next match |
| `⇧⌘G` / `⇧Enter` (in Find) | Previous match |
| `Escape` (Find open) | Close Find and return focus to editor |
| `⇧⌘F` | Search in folder |
| `⌘O` | Open file |
| `⌘N` | New tab |
| `⇧⌘N` | New window |
| `⌘V` | Smart Paste (semantic HTML → Markdown; plain text inside code/math/front matter) |
| `⇧⌘V` | Paste as plain text |
| `⌘W` | Close tab |
| `⌘S` / `⇧⌘S` | Save / Save As |
| `⇧⌘O` | Toggle Outline panel |
| `⌘E` | Toggle Live Preview / Source mode |
| `⌘Z` / `⇧⌘Z` | Undo / Redo |

> **Notes:**
> - `⌘K` inserts a link in the editor (the Command Palette is `⇧⌘P`).
> - `⌘F` searches the current document; `⇧⌘F` searches across the open folder.
> - Spellcheck is toggled in **Settings** (uses native WebView spellcheck on `.cm-content`).
