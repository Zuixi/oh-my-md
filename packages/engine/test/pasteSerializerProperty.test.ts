import { describe, expect, it } from "vitest"
import { escapePasteText, type PasteTextContext } from "../src/paste/triggerPolicy"
import { parseCell } from "../src/parse/cell"
import { markdownLanguageSupport } from "../src/parse/markdown"

// 有界、确定性的 property 语料（plan 02 Task 3）：没有随机数，语料由显式构造
// 得到，失败可直接复现。断言两件事：
//   1. 每个上下文、每个模式都产出稳定字节；
//   2. strict 输出经引擎自己的 parser 后只留下可见文本，不新增语义节点。
//
const PUNCTUATION = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"]
const DELIMITERS = [..."*_`$~^=[]<>|\\:&#!/()"]
const CJK_RTL_EMOJI = ["中", "文", "שלום", "עולם", "😀", "🎉", "日本語", "한국어"]

const CORPUS: readonly string[] = (() => {
  const values: string[] = []
  for (const char of PUNCTUATION) {
    values.push(char, `a${char}b`, `${char}a`, `a${char}`, `${char}${char}`)
  }
  for (const first of DELIMITERS) {
    for (const second of DELIMITERS) values.push(`${first}x${second}`, `a ${first} b ${second} c`)
  }
  for (const characters of CJK_RTL_EMOJI) {
    values.push(characters, `${characters}_x_`, `_${characters}_`, `a${characters}b`)
  }
  for (let count = 0; count <= 4; count++) {
    const backslashes = "\\".repeat(count)
    for (const tail of ["|", "$", "_", "`", "[", "<", "a", "\\"]) values.push(`a${backslashes}${tail}b`)
  }
  values.push(
    // 空白与缩进边界
    " a", "a ", "  a  ", "\ta", "a\tb", "    a", "a    b", "\u00A0", "a\u00A0b",
    // 方言组合
    "$x$", "$$x$$", "==x==", "H~2~O", "x^2^", "~~gone~~", ":smile:", "[^1]",
    "#title", "> quote", "- item", "1. item", "| a | b |", "```js", "~~~", "---", "===",
    "https://x.dev/a", "www.x.dev", "a@b.co", "[a](b)", "[a][b]", "&amp;", "&#32;",
    "a\nb", "  x\n    y",
  )
  return values
})()

const CONTEXTS: readonly PasteTextContext[] = [
  "paragraph",
  "lineStart",
  "emphasis",
  "linkLabel",
  "linkDestination",
  "tableCell",
  "htmlText",
  "htmlAttribute",
]

/** 需要保留可见文本的上下文（destination/attribute 是专用编码，不在此列）。 */
const TEXT_CONTEXTS: readonly PasteTextContext[] = [
  "paragraph",
  "lineStart",
  "emphasis",
  "linkLabel",
  "tableCell",
  "htmlText",
]

type CellNode = ReturnType<typeof parseCell>[number]

function flat(nodes: readonly CellNode[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case "text": case "code": case "math": case "pre": return node.text
      case "image": return node.alt
      case "br": return "<br>"
      case "hr": return "<hr>"
      default: return "children" in node ? flat(node.children) : ""
    }
  }).join("")
}

function types(nodes: readonly CellNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly CellNode[]): void => {
    for (const node of list) {
      out.push(node.type)
      if ("children" in node && Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function expectedVisible(value: string, context: PasteTextContext): string {
  return context === "tableCell" ? value.replace(/\r\n|\r|\n/g, " ") : value
}

describe("deterministic bytes across every context", () => {
  it.each(CONTEXTS)("is stable in both modes in %s", context => {
    for (const value of CORPUS) {
      for (const mode of ["minimal", "strict"] as const) {
        const first = escapePasteText(value, context, mode)
        expect(typeof first).toBe("string")
        expect(escapePasteText(value, context, mode)).toBe(first)
      }
    }
  })

  it("keeps destination output usable as a destination", () => {
    for (const value of CORPUS) {
      for (const mode of ["minimal", "strict"] as const) {
        const output = escapePasteText(value, "linkDestination", mode)
        expect(output).toMatch(/^(?:[^\s()<>]*|<[^<>\n]*>)$/)
      }
    }
  })

  it("keeps attribute output inside double quotes", () => {
    for (const value of CORPUS) {
      const output = escapePasteText(value, "htmlAttribute", "strict")
      expect(output).not.toContain('"')
      expect(output).not.toMatch(/[\r\n]/)
    }
  })
})

describe("strict output carries only visible text", () => {
  it.each(TEXT_CONTEXTS)("adds no semantic node in %s", context => {
    for (const value of CORPUS) {
      const output = escapePasteText(value, context, "strict")
      const nodes = parseCell(output)
      // 唯一允许的结果是可见文本节点（Escape/Entity 会被解析成 text）。
      for (const type of types(nodes)) expect(type).toBe("text")
      if (value.includes("\n") || value.includes("\r")) continue
      expect(flat(nodes)).toBe(expectedVisible(value, context))
    }
  })
})

describe("minimal output only triggers when it must", () => {
  it("keeps identifier-shaped text byte-identical", () => {
    const identifiers = ["access_token", "a_b_c", "foo1_bar2", "snake_case_name", "x2y"]
    for (const context of TEXT_CONTEXTS) {
      for (const value of identifiers) {
        expect(escapePasteText(value, context, "minimal")).toBe(value)
      }
    }
  })

  it("never emits an unescaped line-start structure", () => {
    const structures = ["# h", "> q", "- l", "1. l", "| a |", "```", "---", "    code"]
    for (const value of structures) {
      const nodes = parseCell(escapePasteText(value, "lineStart", "minimal"))
      for (const type of types(nodes)) expect(type).toBe("text")
    }
  })

  it("escapes every dialect opener that would otherwise parse", () => {
    // 语义节点名直接取自引擎 parser 的树（不经过 parseCell 的投影）。
    const SEMANTIC = new Set([
      "Emphasis", "StrongEmphasis", "Strikethrough", "Highlight", "Underline",
      "InlineMath", "MathBlock", "Subscript", "Superscript", "Emoji",
      "FootnoteReference", "Link", "Image",
    ])
    const nodeNames = (source: string): string[] => {
      const names: string[] = []
      const cursor = markdownLanguageSupport().language.parser.parse(source).cursor()
      do { names.push(cursor.name) } while (cursor.next())
      return names
    }
    const openers = ["$x$", "==x==", "H~2~O", "x^2^", "~~strike~~", ":smile:", "[^1]", "**b**", "[a](b)"]
    for (const value of openers) {
      expect(nodeNames(value).filter(name => SEMANTIC.has(name))).not.toHaveLength(0)
      const escaped = nodeNames(escapePasteText(value, "paragraph", "minimal"))
      expect(escaped.filter(name => SEMANTIC.has(name))).toHaveLength(0)
    }
  })
})
