import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { escapePasteText, type PasteTextContext } from "../src/paste/triggerPolicy"
import { parseCell } from "../src/parse/cell"

// 触发器策略是 serializer 发射 literal text 的唯一规则来源。这里的期望值是手写的
// 契约（plan 02 Task 3），不是从实现回抄的：先写“可见文本必须原样保留、且不产生
// 语义节点”，再钉住确定性字节。

type Mode = "minimal" | "strict"

/** 手写三元组：可见文本 → 期望输出。 */
function check(
  value: string,
  context: PasteTextContext,
  mode: Mode,
  expected: string,
): void {
  expect(escapePasteText(value, context, mode)).toBe(expected)
  // 确定性：重复调用字节相同。
  expect(escapePasteText(value, context, mode)).toBe(escapePasteText(value, context, mode))
}

/** parseCell 的可见文本（Escape/Entity 已解码，结构容器展平）。 */
function visible(source: string): string {
  const flatten = (nodes: readonly ReturnType<typeof parseCell>[number][]): string =>
    nodes.map(node => {
      switch (node.type) {
        case "text": case "code": case "math": case "pre": return node.text
        case "image": return node.alt
        case "br": return "<br>"
        case "hr": return "<hr>"
        default: return "children" in node ? flatten(node.children) : ""
      }
    }).join("")
  return flatten(parseCell(source))
}

/** 解析结果里是否出现了不想要的语义容器（parseCell 的 CellNode type）。 */
function cellTypes(source: string): string[] {
  const out: string[] = []
  const walk = (nodes: readonly ReturnType<typeof parseCell>[number][]): void => {
    for (const node of nodes) {
      out.push(node.type)
      if ("children" in node && Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(parseCell(source))
  return out
}

describe("plan exemplars", () => {
  it("leaves ordinary identifiers alone", () => {
    check("access_token", "paragraph", "minimal", "access_token")
    check("snake_case_name", "paragraph", "minimal", "snake_case_name")
  })

  it("escapes a line-start heading", () => {
    check("# title", "lineStart", "minimal", "\\# title")
  })

  it("escapes a math pair", () => {
    check("$x$", "paragraph", "minimal", "\\$x\\$")
    check("$5", "paragraph", "minimal", "$5")
  })

  it("escapes an emphasis pair", () => {
    check("**bold**", "paragraph", "minimal", "\\*\\*bold\\*\\*")
  })

  it("shields table-cell pipes and doubles cell backslashes", () => {
    check("a | b", "tableCell", "minimal", "a \\| b")
    check("a \\ b", "tableCell", "minimal", "a \\\\ b")
    check("a \\| b", "tableCell", "minimal", "a \\\\\\| b")
  })
})

describe("CommonMark punctuation and delimiter adjacency", () => {
  it.each<[string, string]>([
    ["*a*", "\\*a\\*"],
    ["_a_", "\\_a\\_"],
    // intraword `*` 在 CommonMark 里**能**构成 emphasis（只有 `_` 不能）。
    ["a*b*c", "a\\*b\\*c"],
    ["2*3", "2\\*3"],
    ["a * b", "a * b"],
    ["a - b", "a - b"],
    ['say "hi"', 'say "hi"'],
    ["a 'b' c", "a 'b' c"],
    ["a.b c", "a.b c"],
    ["a \\ b", "a \\ b"],
    ["a (b) c", "a (b) c"],
    ["a ! b", "a ! b"],
    ["a , b", "a , b"],
    ["`x`", "\\`x\\`"],
    ["`` a ` b ``", "\\`\\` a \\` b \\`\\`"],
    ["a<b>c", "a\\<b>c"],
    ["<https://example.dev>", "\\<https\\://example.dev>"],
    ["</u>", "\\</u>"],
    ["2 < 3", "2 < 3"],
    ["&amp;", "\\&amp;"],
    ["&#32;", "\\&#32;"],
    ["a & b", "a & b"],
    ["[a](b)", "\\[a](b)"],
    ["[a][b]", "\\[a]\\[b]"],
    ["[a]", "\\[a]"],
    ["[", "["],
    ["a]b", "a]b"],
  ])("escapes %j as %j", (value, expected) => {
    check(value, "paragraph", "minimal", expected)
  })
})

describe("CJK, RTL and emoji", () => {
  it.each<[string, string]>([
    ["中文_强调_结束", "中文\\_强调\\_结束"],
    ["שלום_עולם", "שלום_עולם"],
    ["😀 a", "😀 a"],
    ["a 😀_b_", "a 😀\\_b\\_"],
    [":smile:", "\\:smile:"],
    [":not_an_alias:", ":not_an_alias:"],
  ])("escapes %j as %j", (value, expected) => {
    check(value, "paragraph", "minimal", expected)
  })
})

describe("whitespace and tab", () => {
  it("never squeezes whitespace", () => {
    check("a  b", "paragraph", "minimal", "a  b")
    check("  a", "lineStart", "minimal", "  a")
  })

  it("neutralises indented code at a line start", () => {
    check("    code", "lineStart", "minimal", "&#32;&#32;&#32;&#32;code")
    check("\tcode", "lineStart", "minimal", "&#9;code")
    expect(cellTypes(escapePasteText("    code", "lineStart", "minimal")))
      .not.toContain("pre")
  })
})

describe("GFM triggers", () => {
  it.each<[string, PasteTextContext, string]>([
    ["| a | b |", "lineStart", "\\| a | b |"],
    ["a | b", "paragraph", "a | b"],
    ["- item", "lineStart", "\\- item"],
    ["+ item", "lineStart", "\\+ item"],
    ["   - item", "lineStart", "   \\- item"],
    ["1. item", "lineStart", "1\\. item"],
    ["1) item", "lineStart", "1\\) item"],
    ["1. item", "paragraph", "1. item"],
    ["> quote", "lineStart", "\\> quote"],
    ["  > quote", "lineStart", "  \\> quote"],
    ["[ ] task", "lineStart", "\\[ ] task"],
    ["[x] task", "lineStart", "\\[x] task"],
    ["~~gone~~", "paragraph", "\\~\\~gone\\~\\~"],
    ["---", "lineStart", "\\---"],
    ["***", "lineStart", "\\***"],
    ["___", "lineStart", "\\___"],
    ["```js", "lineStart", "\\`\\`\\`js"],
    ["~~~", "lineStart", "\\~~~"],
    ["===", "lineStart", "\\==="],
    ["#nospace", "lineStart", "#nospace"],
  ])("escapes %j in %s as %j", (value, context, expected) => {
    check(value, context, "minimal", expected)
  })
})

describe("project dialect triggers", () => {
  it.each<[string, string]>([
    ["==mark==", "\\=\\=mark\\=\\="],
    ["===", "==="],
    ["H~2~O", "H\\~2\\~O"],
    ["x^2^", "x\\^2\\^"],
    ["a ~ b", "a ~ b"],
    // `$$` 只有行首才是 MathBlock：段落中间是普通文本。
    ["$$x$$", "$$x$$"],
    ["[^note]", "\\[^note]"],
  ])("escapes %j as %j", (value, expected) => {
    check(value, "paragraph", "minimal", expected)
  })

  it.each<[string, string]>([
    ["$$x$$", "\\$$x$$"],
    ["---\ntitle: x", "\\---\ntitle: x"],
  ])("escapes line-start %j as %j", (value, expected) => {
    check(value, "lineStart", "minimal", expected)
  })
})

describe("HTML, entity and autolink boundaries", () => {
  it.each<[string, string]>([
    ["https://example.dev/a", "https\\://example.dev/a"],
    ["www.example.dev", "www\\.example.dev"],
    ["mail me@example.dev", "mail me\\@example.dev"],
    ["just words", "just words"],
  ])("escapes bare autolinks in %j", (value, expected) => {
    check(value, "paragraph", "minimal", expected)
  })

  it("keeps fixed HTML children literal", () => {
    check("a<b>", "htmlText", "minimal", "a\\<b\\>")
    check('a"b', "htmlAttribute", "minimal", "a&quot;b")
    check("a&b<c", "htmlAttribute", "minimal", "a&amp;b&lt;c")
  })
})

describe("link contexts", () => {
  it("escapes label brackets", () => {
    check("[a]", "linkLabel", "minimal", "\\[a\\]")
    check("a]b", "linkLabel", "minimal", "a\\]b")
    check("*a*", "linkLabel", "minimal", "\\*a\\*")
  })

  it("encodes destinations without backslash escapes", () => {
    check("./notes/a.md", "linkDestination", "minimal", "./notes/a.md")
    check("a b.md", "linkDestination", "minimal", "<a b.md>")
    check("a(b).md", "linkDestination", "minimal", "<a(b).md>")
    check("C:\\Users\\a b\\p.png", "linkDestination", "minimal", "<C:\\Users\\a b\\p.png>")
    check("C:\\Users\\p.png", "linkDestination", "minimal", "<C:\\Users\\p.png>")
    check("a<b.md", "linkDestination", "minimal", "a%3Cb.md")
  })

  it("encodes attributes in both modes", () => {
    for (const mode of ["minimal", "strict"] as const) {
      expect(escapePasteText(`a"b&c`, "htmlAttribute", mode)).toBe("a&quot;b&amp;c")
      expect(escapePasteText("./a.md", "linkDestination", mode)).toBe("./a.md")
    }
  })
})

describe("strict mode", () => {
  it("escapes every CommonMark-escapable ASCII punctuation mark", () => {
    const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    const escaped = escapePasteText(punctuation, "paragraph", "strict")
    expect(escaped).toBe([...punctuation].map(char => `\\${char}`).join(""))
  })

  it("leaves non-punctuation text untouched", () => {
    const value = "abc 中文 שלום 😀 1 2 3"
    expect(escapePasteText(value, "paragraph", "strict")).toBe(value)
  })

  it("doubles literal backslashes", () => {
    check("a \\ b", "paragraph", "strict", "a \\\\ b")
    check("\\", "paragraph", "strict", "\\\\")
  })

  it("protects indentation and tabs", () => {
    check("    x", "paragraph", "strict", "&#32;&#32;&#32;&#32;x")
    check("\tx", "paragraph", "strict", "&#9;x")
    check("a\n\tb", "paragraph", "strict", "a\n&#9;b")
    check("  x", "paragraph", "strict", "  x")
  })

  it("keeps cell pipes shielded in strict mode", () => {
    check("a | b", "tableCell", "strict", "a \\| b")
    check("a \\| b", "tableCell", "strict", "a \\\\\\| b")
    // cell 源码只能是单行：换行折叠成空格。
    check("a\nb", "tableCell", "strict", "a b")
  })
})

describe("extension drift", () => {
  /**
   * 每个注册进 `markdownLanguageSupport()` 的扩展都必须有对应的触发器类别与
   * 一个真实样本；新增 parser extension 却忘记更新 policy 时这条会失败。
   */
  const CATEGORIES: Readonly<Record<string, { context: PasteTextContext; value: string; expected: string }>> = {
    BareAutolink: { context: "paragraph", value: "https://example.dev/a", expected: "https\\://example.dev/a" },
    GFM: { context: "paragraph", value: "~~gone~~", expected: "\\~\\~gone\\~\\~" },
    FrontMatter: { context: "lineStart", value: "---\ntitle: x", expected: "\\---\ntitle: x" },
    Footnotes: { context: "paragraph", value: "[^note]", expected: "\\[^note]" },
    Math: { context: "paragraph", value: "$x$", expected: "\\$x\\$" },
    Rise: { context: "paragraph", value: "H~2~O", expected: "H\\~2\\~O" },
    Highlight: { context: "paragraph", value: "==x==", expected: "\\=\\=x\\=\\=" },
    CjkUnderscore: { context: "paragraph", value: "中_文_了", expected: "中\\_文\\_了" },
    Emoji: { context: "paragraph", value: ":smile:", expected: "\\:smile:" },
  }

  function registeredExtensions(): string[] {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "parse", "markdown.ts")
    const source = readFileSync(path, "utf8")
    const list = /extensions:\s*\[([\s\S]*?)\n\s*\]/.exec(source)?.[1] ?? ""
    return [...list.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)].map(match => match[0])
  }

  it("names every registered parser extension", () => {
    expect(new Set(registeredExtensions())).toEqual(new Set(Object.keys(CATEGORIES)))
    expect(registeredExtensions()).toHaveLength(Object.keys(CATEGORIES).length)
  })

  it.each(Object.entries(CATEGORIES))("escapes the %s category", (_name, category) => {
    expect(escapePasteText(category.value, category.context, "minimal")).toBe(category.expected)
  })
})

describe("parser reciprocity", () => {
  // 转义后的文本经引擎自己的 inline parser 必须回到可见文本，且不新增语义节点。
  it("does not create InlineMath from an escaped opener", () => {
    expect(visible("\\$x\\$")).toBe("$x$")
    expect(cellTypes("\\$x\\$")).not.toContain("math")
    // 未转义时确实是 math：证明这条转义不是装饰性的。
    expect(cellTypes("$x$")).toContain("math")
  })

  it("does not create a FootnoteReference from an escaped bracket", () => {
    expect(visible("\\[^note]")).toBe("[^note]")
    expect(cellTypes("\\[^note]")).not.toContain("link")
  })

  it("does not create a Highlight from escaped equals signs", () => {
    expect(cellTypes("\\=\\=x\\=\\=")).not.toContain("mark")
    expect(cellTypes("==x==")).toContain("mark")
  })

  it("keeps an escaped fixed opening tag literal", () => {
    expect(visible("\\<u>x</u>")).toBe("<u>x</u>")
    expect(cellTypes("\\<u>x</u>")).not.toContain("underline")
    expect(cellTypes("<u>x</u>")).toContain("underline")
  })

  it("keeps a line-start heading escaped", () => {
    const output = escapePasteText("# title", "lineStart", "minimal")
    expect(output).toBe("\\# title")
    expect(visible(output)).toBe("# title")
    expect(cellTypes(output)).not.toContain("strong")
  })
})
