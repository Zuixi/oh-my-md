import { type Command } from "@codemirror/view"
import {
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleUnderline,
  toggleUnorderedList,
} from "@omd/engine"
import type { AppCommand } from "./commands"
import type { Translator } from "./i18n"
import { shortcutFor } from "./shortcuts"

export function formatCommandEntries(
  t: Translator,
  runEditorCommand: (command: Command) => () => void,
): AppCommand[] {
  const entry = (id: string, command: Command): AppCommand => ({
    id,
    label: t(`cmd.label.${id}`),
    shortcut: shortcutFor(id),
    run: runEditorCommand(command),
  })

  return [
    entry("bold", toggleBold),
    entry("italic", toggleItalic),
    entry("underline", toggleUnderline),
    entry("strikethrough", toggleStrikethrough),
    entry("inline-code", toggleInlineCode),
    entry("code-block", toggleCodeBlock),
    entry("heading-1", toggleHeading(1)),
    entry("heading-2", toggleHeading(2)),
    entry("heading-3", toggleHeading(3)),
    entry("heading-4", toggleHeading(4)),
    entry("heading-5", toggleHeading(5)),
    entry("heading-6", toggleHeading(6)),
    entry("ordered-list", toggleOrderedList),
    entry("unordered-list", toggleUnorderedList),
    entry("blockquote", toggleBlockquote),
    entry("link", insertLink),
  ]
}
