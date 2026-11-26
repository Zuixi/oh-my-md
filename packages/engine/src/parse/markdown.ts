import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { CjkUnderscore } from "./cjkUnderscore"
import { Emoji } from "./emoji"
import { EmptyBulletItem } from "./emptyBulletItem"
import { Footnotes } from "./footnotes"
import { FrontMatter } from "./frontMatter"
import { Highlight } from "./highlight"
import { Math } from "./math"
import { Rise } from "./rise"
import { markdownCodeLanguages } from "./codeLanguages"
import { BareAutolink } from "./autolink"

export function markdownLanguageSupport() {
  return markdown({
    codeLanguages: markdownCodeLanguages(),
    extensions: [
      { parseInline: [BareAutolink] },
      GFM,
      FrontMatter,
      EmptyBulletItem,
      Footnotes,
      Math,
      Rise,
      Highlight,
      CjkUnderscore,
      Emoji,
    ],
  })
}
