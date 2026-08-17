import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { CjkUnderscore } from "./cjkUnderscore"
import { Emoji } from "./emoji"
import { Footnotes } from "./footnotes"
import { Highlight } from "./highlight"
import { Math } from "./math"
import { BareAutolink } from "./autolink"

export function markdownLanguageSupport() {
  return markdown({
    extensions: [{ parseInline: [BareAutolink] }, GFM, Footnotes, Math, Highlight, CjkUnderscore, Emoji],
  })
}
