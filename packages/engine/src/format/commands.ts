import { isolateHistory } from "@codemirror/commands"
import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { toggleHeadingSpec, toggleListSpec, toggleQuoteSpec } from "./blockCommands"
import { toggleCodeBlockSpec } from "./codeBlockCommands"
import {
  toggleBoldSpec,
  toggleInlineCodeSpec,
  toggleItalicSpec,
  toggleStrikethroughSpec,
  toggleUnderlineSpec,
} from "./inlineCommands"
import { insertLinkSpec } from "./linkCommand"

// Markdown 排版命令。全部是纯函数：给定 EditorState 返回 TransactionSpec（或 null），
// 由 Command 包装 dispatch，便于 headless 测试。live/source 两模式共用——它们只改源码文本。

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    // readOnly 是建议性 facet：keymap 命令直接 dispatch 会绕过输入拦截
    // （typed input 才被 view 层挡下），只读 Live 预览档必须在此拒绝改写。
    // 返回 false 与 @codemirror/commands 的 readOnly 约定一致，放行后续键位。
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    // Formatting commands are semantic edits, not typed input. Each press must
    // be its own undo step: history's default grouping only joins input/delete
    // events, but an unannotated transaction can still attach to neighboring
    // typed input. "full" isolates both sides of this transaction.
    target.dispatch({
      ...result,
      userEvent: "input.format",
      annotations: isolateHistory.of("full"),
    })
    return true
  }
}

// --- 行内标记（加粗/斜体/删除线/行内代码）---------------------------------------

export const toggleBold = dispatchSpec(toggleBoldSpec)
export const toggleItalic = dispatchSpec(toggleItalicSpec)
export const toggleStrikethrough = dispatchSpec(toggleStrikethroughSpec)
export const toggleUnderline = dispatchSpec(toggleUnderlineSpec)
export const toggleInlineCode = dispatchSpec(toggleInlineCodeSpec)

// --- 标题 ----------------------------------------------------------------------

export function toggleHeading(level: number): Command {
  return dispatchSpec(state => toggleHeadingSpec(state, level))
}

// --- 列表 / 引用 -----------------------------------------------------------------

export const toggleOrderedList = dispatchSpec(state => toggleListSpec(state, "ordered"))
export const toggleUnorderedList = dispatchSpec(state => toggleListSpec(state, "unordered"))

export const toggleBlockquote = dispatchSpec(toggleQuoteSpec)

// --- 代码块 ----------------------------------------------------------------------

export const toggleCodeBlock = dispatchSpec(toggleCodeBlockSpec)

// --- 链接 ------------------------------------------------------------------------

export const insertLink = dispatchSpec(insertLinkSpec)

export { continueList, indentList, listKeymap, outdentList } from "./lists"

// --- 键位 -------------------------------------------------------------------------

export interface MarkdownKeyBinding {
  /** Command id shared with the desktop command palette. */
  id: string
  /** CodeMirror key syntax ("Mod-b", "Mod-Alt-7", …). */
  key: string
  /** macOS display label for the palette; must match `key`. */
  display?: string
  run: Command
}

/**
 * Single source of truth for the Markdown formatting keymap. `markdownKeymap`
 * uses `key` for the editor binding and the palette shows `display`, so a
 * shortcut change is made in exactly one place. Alternate keys for the same
 * command may appear without `display` (the palette shows the primary binding).
 */
export const markdownKeyBindings: readonly MarkdownKeyBinding[] = [
  { id: "bold", key: "Mod-b", display: "⌘B", run: toggleBold },
  { id: "italic", key: "Mod-i", display: "⌘I", run: toggleItalic },
  { id: "underline", key: "Mod-u", display: "⌘U", run: toggleUnderline },
  { id: "strikethrough", key: "Mod-Shift-x", display: "⇧⌘X", run: toggleStrikethrough },
  { id: "inline-code", key: "Mod-`", display: "⌘`", run: toggleInlineCode },
  { id: "inline-code", key: "Mod-Shift-`", run: toggleInlineCode },
  { id: "inline-code", key: "Mod-Shift-~", run: toggleInlineCode },
  { id: "code-block", key: "Mod-Shift-k", display: "⇧⌘K", run: toggleCodeBlock },
  { id: "heading-1", key: "Mod-1", display: "⌘1", run: toggleHeading(1) },
  { id: "heading-2", key: "Mod-2", display: "⌘2", run: toggleHeading(2) },
  { id: "heading-3", key: "Mod-3", display: "⌘3", run: toggleHeading(3) },
  { id: "heading-4", key: "Mod-4", display: "⌘4", run: toggleHeading(4) },
  { id: "heading-5", key: "Mod-5", display: "⌘5", run: toggleHeading(5) },
  { id: "heading-6", key: "Mod-6", display: "⌘6", run: toggleHeading(6) },
  { id: "ordered-list", key: "Mod-Alt-7", display: "⌥⌘7", run: toggleOrderedList },
  { id: "unordered-list", key: "Mod-Alt-8", display: "⌥⌘8", run: toggleUnorderedList },
  { id: "blockquote", key: "Mod-Alt-9", display: "⌥⌘9", run: toggleBlockquote },
  { id: "link", key: "Mod-k", display: "⌘K", run: insertLink },
] as const

// Hosts register the generic defaultKeymap before editorExtensions(). At equal
// precedence that map shadows several formatting shortcuts (notably Mod-i and
// Mod-Shift-k), so formatting bindings must opt into a higher precedence. The
// specialized block/table keymaps use Prec.highest for their own keys and still
// win where their semantics are more specific.
export const markdownKeymap = Prec.high(
  keymap.of(markdownKeyBindings.map(({ key, run }) => ({ key, run }))),
)

export const markdownShortcutLabels: Readonly<Record<string, string>> = Object.fromEntries(
  markdownKeyBindings
    .filter((binding): binding is MarkdownKeyBinding & { display: string } =>
      binding.display !== undefined)
    .map(binding => [binding.id, binding.display]),
)

/** id → normalized CodeMirror key ("Mod-Shift-x"); hosts format per platform (spec D7). */
export const markdownShortcutBindings: Readonly<Record<string, string>> = Object.fromEntries(
  markdownKeyBindings
    .filter(binding => binding.display !== undefined)
    .map(binding => [binding.id, binding.key]),
)
