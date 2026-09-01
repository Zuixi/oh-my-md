import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

/**
 * 编辑态代码高亮（嵌套 Lezer 语言 + 本样式）：色板走 CSS 变量，明暗主题由
 * styles.css 的 html[data-theme] 块各自定义（与 Shiki 渲染态的 github 主题观感
 * 对齐）。样式只声明代码语义 tag —— markdown 散文解析（emphasis/heading/link）
 * 不产出这些 tag，不会误染色。
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--omd-syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--omd-syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--omd-syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--omd-syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--omd-syn-function)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--omd-syn-definition)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--omd-syn-type)" },
  { tag: [t.tagName], color: "var(--omd-syn-tag)" },
  { tag: [t.attributeName], color: "var(--omd-syn-attribute)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--omd-syn-punctuation)" },
  { tag: [t.meta, t.annotation], color: "var(--omd-syn-comment)" },
])

export function codeSyntaxHighlighting() {
  return syntaxHighlighting(codeHighlightStyle)
}
