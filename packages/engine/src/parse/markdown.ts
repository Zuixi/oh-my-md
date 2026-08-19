import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { CjkUnderscore } from "./cjkUnderscore"
import { Emoji } from "./emoji"
import { Footnotes } from "./footnotes"
import { FrontMatter } from "./frontMatter"
import { Highlight } from "./highlight"
import { Math } from "./math"
import { Rise } from "./rise"
import { BareAutolink } from "./autolink"

export function markdownLanguageSupport() {
  return markdown({
    extensions: [
      { parseInline: [BareAutolink] },
      GFM,
      FrontMatter,
      Footnotes,
      Math,
      Rise,
      Highlight,
      CjkUnderscore,
      Emoji,
    ],
  })
}
