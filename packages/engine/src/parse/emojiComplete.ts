import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import type { EditorState } from "@codemirror/state"
import { suggestEmoji } from "./emoji"
import { inCode } from "./verbatim"

const MAX_EMOJI_SUGGESTIONS = 40
const QUERY = /:([a-z0-9_+-]*):?$/
const WORD = /[A-Za-z0-9]/
function emojiQuery(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos)
  const match = QUERY.exec(line.text.slice(0, pos - line.from))
  if (!match || match.index === undefined) return null
  const from = line.from + match.index
  if (from > line.from && WORD.test(state.doc.sliceString(from - 1, from))) return null
  if (inCode(state, pos)) return null
  return { from, query: match[1] }
}

export function emojiCompletions(context: CompletionContext): CompletionResult | null {
  const found = emojiQuery(context.state, context.pos)
  if (!found) return null
  const options = suggestEmoji(found.query).slice(0, MAX_EMOJI_SUGGESTIONS).map(item => ({
    label: `:${item.alias}:`,
    displayLabel: `${item.ch}  ${item.alias}`,
    apply: item.ch,
  }))
  if (!options.length) return null
  return { from: found.from, options, filter: false }
}

export const emojiCompletion = autocompletion({
  override: [emojiCompletions],
  activateOnTyping: true,
  icons: false,
})
