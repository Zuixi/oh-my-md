import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_PASTE_DOM_DEPTH, MAX_PASTE_DOM_NODES, MAX_PASTE_HTML_CHARS } from "../src/paste/limits"
import type { PasteBlock, PasteDiagnostic, PasteInline, PreparedSmartPaste } from "../src/paste/model"
import {
  normalizeHtmlPaste,
  normalizeHtmlPasteWithinLimits,
  preparePlainTextFallback,
} from "../src/paste/normalizeHtml"

// Deterministic adversarial matrix for the inert HTML normalizer (plan 02 Task 2).
//
// Nothing here is random: the fixture list below is a fixed strided combination
// of hostile fragments, so a failure is always reproducible. Two properties are
// asserted for every generated input:
//   1. normalization is total — it never throws and always answers with the
//      documented `semantic | literalFallback` policy;
//   2. the answer carries no markup: the AST is walked against an explicit
//      key whitelist, so raw attributes, event handlers, `data-*`, inline CSS,
//      script/style content or arbitrary HTML cannot survive unless the AST
//      contract itself grows a field (which would be a visible model change).

// --- fragment catalogues ----------------------------------------------------

/** Crossed, unclosed, stray and truncated markup: the parser feeds us garbage. */
const MALFORMED = [
  "<p><em>a</p></em>",
  "<div><span></div></span>",
  "<b><i>x",
  "</table></ul></div>",
  "<p><p><p>x",
  "<img src=x alt=",
  "<a href='x' <p>y</p>",
  "<table><tr><td>x</table></tr>",
  "<ul><li>a<ul><li>b",
  "<",
  "<p>&lt;script&gt;x&lt;/script&gt;</p>",
  "<blockquote><div><blockquote>x",
  "<td><th>orphan",
] as const

/** Real elements whose *behavior* must never reach the AST. */
const HOSTILE_ELEMENTS = [
  "<script>alert('s')</script>",
  "<style>body{display:none}</style>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="x.swf">o</object>',
  '<form action="https://evil.example/collect"><input name="v" value="v"></form>',
  "<svg><script>alert(1)</script><text>t</text></svg>",
  "<math><mi>m</mi></math>",
  "<template><b>tpl</b></template>",
  "<noscript>ns</noscript>",
  "<video src=\"https://cdn.example/x.mp4\">v</video>",
] as const

const WRAPPERS = ["strong", "b", "em", "i", "u", "s", "del", "mark", "kbd", "sub", "sup", "span", "font"] as const

/** Presentation CSS plus the three semantic declarations the AST does keep. */
const STYLE_FRAGMENTS = [
  'style="color:red;background:url(javascript:alert(1))"',
  'style="font-weight:700"',
  'style="text-decoration:underline"',
  'style="font-style:italic;position:fixed"',
  'style="text-align:center;display:none"',
  'style="margin:0!important;font-size:9px"',
  'style=""',
] as const

/** Event handlers, tracking attributes and arbitrary data payloads. */
const HOSTILE_ATTRIBUTES = [
  'onclick="alert(1)"',
  "onerror=alert(2)",
  'onload="alert(3)"',
  'data-secret="leak"',
  'data-trackid="abc"',
  'contenteditable="true"',
  'class="language-js note"',
  'id="pasted"',
  'srcdoc="<script>alert(4)</script>"',
] as const

const DANGEROUS_URLS = [
  "javascript:alert(1)",
  "java&#9;script:alert(1)",
  "&#106;avascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "file:///etc/passwd",
  "blob:https://evil.example/0b1c",
  "//evil.example/x.png",
  "%6aavascript:alert(1)",
] as const

const VALID_URLS = [
  "https://example.com/a?b=1#c",
  "http://example.com/",
  "/root/a.md",
  "./a.md",
  "../up/a.png",
  "notes/other.md",
  "mailto:me@example.com",
  "#section-2",
] as const

const IMAGE_URLS = [
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/webp;base64,UklGRg==",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "blob:https://evil.example/0b1c",
  "https://cdn.example/a.png",
  "javascript:alert(1)",
  "/assets/a.png",
  "",
] as const

/** Comments and the odd whitespace HTML treats specially. */
const COMMENTS = [
  "<!-- comment -->",
  "<!---->",
  "<!--[if IE]><script>alert(1)</script><![endif]-->",
  "<!--><script>alert(1)</script>-->",
] as const

const WHITESPACE = ["", " ", "\n\n\t  ", "&nbsp;\u00a0", "&#x20;&#x09;", "\u200b\ufeff", "\r\n"] as const

/** Every generated input stays far below these limits; the guard is explicit. */
const GENERATED_BOUNDS = { maxDepth: 32, maxNodes: 5_000 } as const

interface FuzzCase { readonly name: string; readonly html: string; readonly plainText: string }

/** Strided (never random) combination of every catalogue. */
function buildCases(count: number): FuzzCase[] {
  const cases: FuzzCase[] = []
  for (let index = 0; index < count; index += 1) {
    const malformed = MALFORMED[index % MALFORMED.length]
    const hostile = HOSTILE_ELEMENTS[(index * 3) % HOSTILE_ELEMENTS.length]
    const wrapper = WRAPPERS[(index * 5) % WRAPPERS.length]
    const nesting = 1 + (index % 4)
    // Stride must stay coprime with the catalogue length or the modulo collapses
    // onto a single entry (7 * index % 7 === 0).
    const style = STYLE_FRAGMENTS[(index * 3) % STYLE_FRAGMENTS.length]
    const attribute = HOSTILE_ATTRIBUTES[(index * 11) % HOSTILE_ATTRIBUTES.length]
    const link = DANGEROUS_URLS[(index * 13) % DANGEROUS_URLS.length]
    const safeLink = VALID_URLS[(index * 17) % VALID_URLS.length]
    const image = IMAGE_URLS[(index * 19) % IMAGE_URLS.length]
    const comment = COMMENTS[(index * 23) % COMMENTS.length]
    const space = WHITESPACE[(index * 29) % WHITESPACE.length]

    const open = Array.from({ length: nesting }, () => `<${wrapper}>`).join("")
    const close = Array.from({ length: nesting }, () => `</${wrapper}>`).join("")
    const html = [
      space, malformed, space, hostile, space,
      `<div ${attribute} ${style} ${space}>`,
      `<p ${style} ${attribute}>${comment}${open}w${index}${close}</p>`,
      `<a href="${link}" ${attribute}>bad${index}</a>`,
      `<a href="${safeLink}">good${index}</a>`,
      `<img src="${image}" ${attribute} alt="i${index}">`,
      `</div>`, comment, space,
    ].join("")

    cases.push({ name: `case-${index}`, html, plainText: `plain ${index}` })
  }
  return cases
}

const CASES = buildCases(210)

// --- AST audit --------------------------------------------------------------

type Problem = string

const INLINE_KEYS: Readonly<Record<string, readonly string[]>> = {
  text: ["type", "value"],
  code: ["type", "value"],
  hardBreak: ["type"],
  link: ["type", "href", "title", "children"],
  image: ["type", "alt", "title", "source"],
  strong: ["type", "children"],
  emphasis: ["type", "children"],
  strike: ["type", "children"],
  highlight: ["type", "children"],
  underline: ["type", "children"],
  kbd: ["type", "children"],
  subscript: ["type", "children"],
  superscript: ["type", "children"],
}

const BLOCK_KEYS: Readonly<Record<string, readonly string[]>> = {
  paragraph: ["type", "children"],
  heading: ["type", "level", "children"],
  blockquote: ["type", "children"],
  list: ["type", "ordered", "start", "items"],
  codeBlock: ["type", "language", "value"],
  table: ["type", "table"],
  horizontalRule: ["type"],
}

const SOURCE_KEYS: Readonly<Record<string, readonly string[]>> = {
  url: ["kind", "value"],
  embedded: ["kind", "key", "mime", "base64"],
  unavailable: ["kind", "key"],
}

const DIAGNOSTIC_KINDS = new Set<PasteDiagnostic["kind"]>([
  "strictFallback", "unsupportedTable", "droppedStyle", "rejectedUrl", "unresolvedAsset",
])

/** A URL that reaches the AST must already have passed the URL policy. */
const FORBIDDEN_SCHEME = /^\s*(?:javascript|vbscript|data|blob|file|filesystem|jar|about|chrome|moz-extension):/i

function keysMatch(node: object, expected: readonly string[] | undefined, path: string, problems: Problem[]): boolean {
  if (!expected) {
    problems.push(`${path}: no whitelisted key set`)
    return false
  }
  const actual = Object.keys(node).sort().join(",")
  if (actual !== [...expected].sort().join(",")) {
    problems.push(`${path}: unexpected keys [${actual}], allowed [${expected.join(",")}]`)
    return false
  }
  return true
}

function auditUrl(value: string, kind: "href" | "src", path: string, problems: Problem[]): void {
  if (FORBIDDEN_SCHEME.test(value)) problems.push(`${path}: forbidden scheme in ${kind}: ${value}`)
  if (kind === "src" && value.startsWith("#")) problems.push(`${path}: fragment image src`)
}

function auditInline(node: PasteInline, path: string, problems: Problem[]): void {
  if (!keysMatch(node, INLINE_KEYS[node.type], path, problems)) return
  switch (node.type) {
    case "text":
      return
    case "code":
      return
    case "hardBreak":
      return
    case "link":
      auditUrl(node.href, "href", `${path}.href`, problems)
      if (node.title !== null && typeof node.title !== "string") problems.push(`${path}.title: not a string`)
      for (const [index, child] of node.children.entries()) auditInline(child, `${path}.children[${index}]`, problems)
      return
    case "image": {
      if (!keysMatch(node.source, SOURCE_KEYS[node.source.kind], `${path}.source`, problems)) return
      if (node.source.kind === "url") auditUrl(node.source.value, "src", `${path}.source.value`, problems)
      if (node.source.kind === "embedded" && !node.source.mime.startsWith("image/")) {
        problems.push(`${path}.source.mime: not an image mime: ${node.source.mime}`)
      }
      return
    }
    default:
      for (const [index, child] of node.children.entries()) auditInline(child, `${path}.children[${index}]`, problems)
  }
}

function auditBlocks(blocks: readonly PasteBlock[], path: string, problems: Problem[]): void {
  for (const [index, block] of blocks.entries()) {
    const at = `${path}[${index}]`
    if (!keysMatch(block, BLOCK_KEYS[block.type], at, problems)) continue
    switch (block.type) {
      case "horizontalRule":
        break
      case "codeBlock":
        break
      case "paragraph":
      case "heading":
        auditInlineChildren(block.children, at, problems)
        break
      case "blockquote":
        auditBlocks(block.children, `${at}.children`, problems)
        break
      case "list":
        for (const [itemIndex, item] of block.items.entries()) {
          if (!keysMatch(item, ["checked", "children"], `${at}.items[${itemIndex}]`, problems)) continue
          auditBlocks(item.children, `${at}.items[${itemIndex}].children`, problems)
        }
        break
      case "table":
        if (!keysMatch(block.table, ["rows", "requiresComplexHtml"], `${at}.table`, problems)) break
        for (const [rowIndex, row] of block.table.rows.entries()) {
          const rowAt = `${at}.table.rows[${rowIndex}]`
          if (!keysMatch(row, ["cells"], rowAt, problems)) continue
          for (const [cellIndex, cell] of row.cells.entries()) {
            const cellAt = `${rowAt}.cells[${cellIndex}]`
            const cellKeys = ["header", "scope", "rowSpan", "colSpan", "align", "blocks"]
            if (!keysMatch(cell, cellKeys, cellAt, problems)) continue
            auditBlocks(cell.blocks, `${cellAt}.blocks`, problems)
          }
        }
        break
    }
  }
}

function auditInlineChildren(children: readonly PasteInline[], path: string, problems: Problem[]): void {
  for (const [index, child] of children.entries()) auditInline(child, `${path}.children[${index}]`, problems)
}

/** Full contract audit of one normalization result. */
function audit(result: PreparedSmartPaste, label: string): Problem[] {
  const problems: Problem[] = []
  if (result.policy !== "semantic" && result.policy !== "literalFallback") {
    problems.push(`${label}: unknown policy ${String(result.policy)}`)
  }
  auditBlocks(result.document.blocks, "document.blocks", problems)
  for (const [index, asset] of result.assets.entries()) {
    if (!keysMatch(asset, ["key", "mime", "base64", "alt"], `assets[${index}]`, problems)) continue
    if (!asset.mime.startsWith("image/")) problems.push(`assets[${index}]: not an image mime ${asset.mime}`)
  }
  for (const [index, key] of result.unavailableImageKeys.entries()) {
    if (typeof key !== "string") problems.push(`unavailableImageKeys[${index}]: not a string`)
  }
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (!keysMatch(diagnostic, ["kind", "count"], `diagnostics[${index}]`, problems)) continue
    if (!DIAGNOSTIC_KINDS.has(diagnostic.kind)) problems.push(`diagnostics[${index}]: unknown kind ${diagnostic.kind}`)
  }
  return problems
}

/**
 * Structural strings of the payload: every place a *derived* value (URL, title,
 * language, asset key/mime) can live. User-visible data leaves are excluded on
 * purpose — a text node is character data, so a mangled `<style>` whose tag was
 * eaten by a truncated attribute can leave the literal text `display:none` in
 * the document without any CSS having been applied. The proof that no attribute
 * or declaration survives is structural (the key whitelist above has nowhere to
 * put one); this scan is the defense-in-depth check for derived fields.
 */
function structuralStrings(result: PreparedSmartPaste): string[] {
  const out: string[] = []
  const add = (value: string | null): void => {
    if (value !== null) out.push(value)
  }
  const inline = (node: PasteInline): void => {
    switch (node.type) {
      case "text":
      case "code":
      case "hardBreak":
        return
      case "link":
        add(node.href)
        add(node.title)
        for (const child of node.children) inline(child)
        return
      case "image":
        add(node.title)
        if (node.source.kind === "url") add(node.source.value)
        else out.push(`${node.source.key} ${node.source.kind}`)
        return
      default:
        for (const child of node.children) inline(child)
    }
  }
  const blocks = (list: readonly PasteBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "horizontalRule":
          break
        case "codeBlock":
          add(block.language)
          break
        case "paragraph":
        case "heading":
          for (const child of block.children) inline(child)
          break
        case "blockquote":
          blocks(block.children)
          break
        case "list":
          for (const item of block.items) blocks(item.children)
          break
        case "table":
          for (const row of block.table.rows) {
            for (const cell of row.cells) {
              add(cell.scope)
              add(cell.align)
              blocks(cell.blocks)
            }
          }
          break
      }
    }
  }
  blocks(result.document.blocks)
  for (const asset of result.assets) out.push(`${asset.key} ${asset.mime}`)
  for (const key of result.unavailableImageKeys) out.push(key)
  return out
}

/** Derived fields must not carry markup, handlers or CSS out of the normalizer. */
const FORBIDDEN_SUBSTRINGS = [
  "alert(", "javascript:", "vbscript:", "onerror", "onclick", "onload", "data-secret",
  "data-trackid", "style=", "color:red", "text-decoration", "position:fixed", "display:none",
  "background:", "srcdoc", "<script", "<style",
] as const

function markupLeaks(result: PreparedSmartPaste): Problem[] {
  const serialized = structuralStrings(result).join("\n")
  return FORBIDDEN_SUBSTRINGS.filter(token => serialized.includes(token))
}

// --- generated matrix -------------------------------------------------------

describe("normalizeHtmlPaste — deterministic adversarial matrix", () => {
  it("keeps generation bounded and exhaustive over the catalogues", () => {
    // Bounded: a fixed, non-random count that still covers every fragment.
    expect(CASES.length).toBeLessThanOrEqual(256)
    expect(new Set(CASES.map(item => item.html)).size).toBe(CASES.length)
    for (const item of CASES) expect(item.html.length).toBeLessThanOrEqual(4_096)
    // Every catalogue entry is actually used, so no fragment silently rots.
    const joined = CASES.map(item => item.html).join("")
    for (const fragment of [...DANGEROUS_URLS, ...HOSTILE_ATTRIBUTES, ...STYLE_FRAGMENTS]) {
      expect(joined).toContain(fragment)
    }
  })

  it("never throws and never exceeds the explicit bounds", () => {
    for (const item of CASES) {
      let result: PreparedSmartPaste | null = null
      expect(() => {
        result = normalizeHtmlPasteWithinLimits({ html: item.html, plainText: item.plainText }, GENERATED_BOUNDS)
      }, item.name).not.toThrow()
      // Within the bounds every generated case normalizes semantically: the
      // literal fallback is reserved for limit overflow, not for weird markup.
      expect(result!.policy, item.name).toBe("semantic")
      expect(audit(result!, item.name), item.name).toEqual([])
    }
  })

  it("never leaves markup, handlers or presentation CSS in the AST or assets", () => {
    for (const item of CASES) {
      const result = normalizeHtmlPaste({ html: item.html, plainText: item.plainText })
      expect(audit(result, item.name), item.name).toEqual([])
      expect(markupLeaks(result), item.name).toEqual([])
    }
  })

  it("drops every dangerous URL while keeping the visible text", () => {
    for (const dangerous of DANGEROUS_URLS) {
      const result = normalizeHtmlPaste({
        html: `<a href="${dangerous}">visible</a><img src="${dangerous}" alt="pic">`,
        plainText: "visible",
      })
      const serialized = JSON.stringify(result.document)
      expect(serialized, dangerous).toContain("visible")
      expect(serialized, dangerous).not.toContain("javascript:")
      expect(serialized, dangerous).not.toContain("alert(")
      expect(serialized, dangerous).not.toContain("data:image/svg")
      expect(result.policy).toBe("semantic")
      expect(audit(result, dangerous)).toEqual([])
    }
  })

  it("treats entity-decoded markup as text and real script/style as absent", () => {
    // `&lt;script&gt;` is character data: it must land in a text node verbatim…
    const escaped = normalizeHtmlPaste({
      html: "<p>&lt;script&gt;x&lt;/script&gt;</p>",
      plainText: "<script>x</script>",
    })
    expect(escaped).toEqual({
      policy: "semantic",
      document: { blocks: paragraphText("<script>x</script>") },
      plainText: "<script>x</script>",
      assets: [],
      unavailableImageKeys: [],
      isSingleImageOnly: false,
      diagnostics: [],
    })
    // …while the real element contributes no node and no text at all.
    const real = normalizeHtmlPaste({
      html: '<script>alert(1)</script><style>body{display:none}</style><p>kept</p>',
      plainText: "kept",
    })
    expect(real.document.blocks).toEqual(paragraphText("kept"))
    expect(JSON.stringify(real.document)).not.toContain("alert(")
    expect(JSON.stringify(real.document)).not.toContain("display:none")
  })

  it("keeps the semantic declarations but no presentation CSS", () => {
    const result = normalizeHtmlPaste({
      html: '<p style="color:red;font-weight:700;font-style:italic;text-decoration:underline line-through">styled</p>',
      plainText: "styled",
    })
    expect(result).toEqual({
      policy: "semantic",
      document: {
        blocks: [{
          type: "paragraph",
          children: [{
            type: "strong",
            children: [{
              type: "emphasis",
              children: [{
                type: "underline",
                children: [{ type: "strike", children: [{ type: "text", value: "styled" }] }],
              }],
            }],
          }],
        }],
      },
      plainText: "styled",
      assets: [],
      unavailableImageKeys: [],
      isSingleImageOnly: false,
      diagnostics: [{ kind: "droppedStyle", count: 1 }],
    })
  })
})

// --- side-effect freedom ----------------------------------------------------

describe("normalizeHtmlPaste — no resource execution", () => {
  const spies: { mockRestore: () => void }[] = []

  function guard(): { readonly calls: () => number } {
    let calls = 0
    const record = (): void => { calls += 1 }
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      record()
      throw new Error("network access during paste normalization")
    }) as typeof fetch)
    spies.push(fetchSpy)
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => { record() })
    spies.push(openSpy)
    const sendSpy = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => { record() })
    spies.push(sendSpy)
    return { calls: () => calls }
  }

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  describe("normalizeHtmlPaste — pre-DOM allocation guard", () => {
    it("parses at the HTML size limit", () => {
      const parse = vi.spyOn(DOMParser.prototype, "parseFromString")
      const result = normalizeHtmlPaste({
        html: "x".repeat(MAX_PASTE_HTML_CHARS),
        plainText: "fallback",
      })
      expect(result.policy).toBe("semantic")
      expect(parse).toHaveBeenCalledOnce()
      parse.mockRestore()
    })

    it("falls back before DOMParser above the HTML size limit", () => {
      const parse = vi.spyOn(DOMParser.prototype, "parseFromString")
      const result = normalizeHtmlPaste({
        html: "x".repeat(MAX_PASTE_HTML_CHARS + 1),
        plainText: "# visible",
      })
      expect(result).toEqual(preparePlainTextFallback("# visible"))
      expect(parse).not.toHaveBeenCalled()
      parse.mockRestore()
    })
  })

  it("never fetches remote images, frames or styles for generated input", () => {
    const network = guard()
    const before = document.body.childNodes.length
    for (const item of CASES) normalizeHtmlPaste({ html: item.html, plainText: item.plainText })
    expect(network.calls()).toBe(0)
    // The parsed document stays detached: nothing is adopted into the live one.
    expect(document.body.childNodes.length).toBe(before)
    expect(document.querySelectorAll("img, script, style, iframe, link")).toHaveLength(0)
  })

  it("does not construct live image loaders for <img> sources", () => {
    const network = guard()
    const original = globalThis.Image
    let constructed = 0
    globalThis.Image = class {
      constructor() {
        constructed += 1
        throw new Error("live Image during paste normalization")
      }
    } as unknown as typeof Image
    try {
      for (const item of CASES) normalizeHtmlPaste({ html: item.html, plainText: item.plainText })
      expect(constructed).toBe(0)
      expect(network.calls()).toBe(0)
    } finally {
      globalThis.Image = original
    }
  })
})

// --- determinism ------------------------------------------------------------

describe("normalizeHtmlPaste — deterministic repetition", () => {
  it("returns deep-equal and byte-identical payloads across repeated calls", () => {
    for (const item of CASES) {
      const first = normalizeHtmlPaste({ html: item.html, plainText: item.plainText })
      const second = normalizeHtmlPaste({ html: item.html, plainText: item.plainText })
      expect(second, item.name).toEqual(first)
      expect(JSON.stringify(second), item.name).toBe(JSON.stringify(first))
    }
  })

  it("returns deep-equal and byte-identical payloads on the limit fallback path", () => {
    const limits = { maxDepth: 1, maxNodes: 1 }
    let fallbacks = 0
    for (const item of CASES) {
      const first = normalizeHtmlPasteWithinLimits({ html: item.html, plainText: item.plainText }, limits)
      const second = normalizeHtmlPasteWithinLimits({ html: item.html, plainText: item.plainText }, limits)
      expect(second, item.name).toEqual(first)
      expect(JSON.stringify(second), item.name).toBe(JSON.stringify(first))
      // A one-node budget either overflows into the literal fallback or, for the
      // handful of inputs that parse to nothing, answers with an empty document.
      if (first.policy === "literalFallback") {
        fallbacks += 1
        expect(first, item.name).toEqual(preparePlainTextFallback(item.plainText))
      } else {
        expect(first.document.blocks, item.name).toEqual([])
      }
      expect(audit(first, item.name), item.name).toEqual([])
    }
    // The fallback branch is genuinely exercised by the matrix, not just reachable.
    expect(fallbacks).toBeGreaterThan(0)
  })
})

// --- exact limits -----------------------------------------------------------

/** `<div>` nesting of the given depth, with the text one level below it. */
function nestedDivs(depth: number): string {
  return "<div>".repeat(depth) + "x" + "</div>".repeat(depth)
}

function paragraphText(value: string): PasteBlock[] {
  return [{ type: "paragraph", children: [{ type: "text", value }] }]
}

describe("normalizeHtmlPaste — exact depth boundary", () => {
  it("accepts depth == limit, and falls back one level beyond it", () => {
    for (const depth of [1, 2, 3, 4, 8]) {
      const html = nestedDivs(depth)
      const allowed = normalizeHtmlPasteWithinLimits(
        { html, plainText: "x" },
        { maxDepth: depth, maxNodes: 1_000 },
      )
      expect(allowed.policy, `depth ${depth}`).toBe("semantic")
      expect(allowed.document.blocks, `depth ${depth}`).toEqual(paragraphText("x"))

      const oneMore = normalizeHtmlPasteWithinLimits(
        { html, plainText: "x" },
        { maxDepth: depth - 1, maxNodes: 1_000 },
      )
      expect(oneMore, `depth ${depth - 1}`).toEqual(preparePlainTextFallback("x"))

      // …and the extra headroom is still semantic: only `limit == depth` matters.
      const room = normalizeHtmlPasteWithinLimits(
        { html, plainText: "x" },
        { maxDepth: depth + 1, maxNodes: 1_000 },
      )
      expect(room.policy, `depth ${depth + 1}`).toBe("semantic")
      expect(room.document.blocks, `depth ${depth + 1}`).toEqual(paragraphText("x"))
    }
  })

  it("applies the depth guard through wrapper and list frames too", () => {
    const html = "<ul><li><strong><em><span>x</em></strong></span></li></ul>"
    // body > ul(1) > li(2) > strong(3) > em(4) > span(5) > text(6, not depth-checked)
    expect(
      normalizeHtmlPasteWithinLimits({ html, plainText: "x" }, { maxDepth: 5, maxNodes: 1_000 }).policy,
    ).toBe("semantic")
    expect(
      normalizeHtmlPasteWithinLimits({ html, plainText: "x" }, { maxDepth: 4, maxNodes: 1_000 }),
    ).toEqual(preparePlainTextFallback("x"))
  })

  it("falls back one level past the default depth guard and stays semantic at it", () => {
    expect(MAX_PASTE_DOM_DEPTH).toBe(256)
    const atLimit = normalizeHtmlPaste({ html: nestedDivs(MAX_PASTE_DOM_DEPTH), plainText: "x" })
    expect(atLimit.policy).toBe("semantic")
    expect(atLimit.document.blocks).toEqual(paragraphText("x"))
    expect(normalizeHtmlPaste({ html: nestedDivs(MAX_PASTE_DOM_DEPTH + 1), plainText: "x" }))
      .toEqual(preparePlainTextFallback("x"))
  })
})

describe("normalizeHtmlPaste — exact node-count boundary", () => {
  /** Fixture → the node budget it exactly consumes (elements + text nodes). */
  const fixtures: readonly { readonly html: string; readonly nodes: number; readonly blocks: PasteBlock[] }[] = [
    // <p> + text
    { html: "<p>a</p>", nodes: 2, blocks: paragraphText("a") },
    // <p> + text + <ul> + <li> + text
    {
      html: "<p>a</p><ul><li>b</li></ul>",
      nodes: 5,
      blocks: [
        { type: "paragraph", children: [{ type: "text", value: "a" }] },
        { type: "list", ordered: false, start: null, items: [{ checked: null, children: paragraphText("b") }] },
      ],
    },
    // <p> + text + <script> + its text (skipped subtrees still count)
    { html: "<p>a</p><script>x</script>", nodes: 4, blocks: paragraphText("a") },
    // <pre> + its text: the element is entered (1) and `countSubtree` then counts
    // the descendants it never walks individually (2).
    { html: "<pre>x</pre>", nodes: 2, blocks: [{ type: "codeBlock", language: "", value: "x" }] },
  ]

  it("accepts exactly the budget, and falls back one node above it", () => {
    for (const fixture of fixtures) {
      const over = normalizeHtmlPasteWithinLimits(
        { html: fixture.html, plainText: "fallback" },
        { maxDepth: 32, maxNodes: fixture.nodes - 1 },
      )
      expect(over, `${fixture.html} @ ${fixture.nodes - 1}`).toEqual(preparePlainTextFallback("fallback"))

      const exact = normalizeHtmlPasteWithinLimits(
        { html: fixture.html, plainText: "fallback" },
        { maxDepth: 32, maxNodes: fixture.nodes },
      )
      expect(exact.policy, `${fixture.html} @ ${fixture.nodes}`).toBe("semantic")
      expect(exact.document.blocks, `${fixture.html} @ ${fixture.nodes}`).toEqual(fixture.blocks)

      const slack = normalizeHtmlPasteWithinLimits(
        { html: fixture.html, plainText: "fallback" },
        { maxDepth: 32, maxNodes: fixture.nodes + 1 },
      )
      expect(slack.policy, `${fixture.html} @ ${fixture.nodes + 1}`).toBe("semantic")
      expect(slack.document.blocks, `${fixture.html} @ ${fixture.nodes + 1}`).toEqual(fixture.blocks)
    }
  })

  it("keeps the default node guard conservative", () => {
    expect(MAX_PASTE_DOM_NODES).toBe(200_000)
    expect(
      normalizeHtmlPasteWithinLimits(
        { html: "<p>a</p>", plainText: "a" },
        { maxDepth: MAX_PASTE_DOM_DEPTH, maxNodes: MAX_PASTE_DOM_NODES },
      ).policy,
    ).toBe("semantic")
  })

  it("refuses to return a truncated AST when a whole hostile document is over budget", () => {
    const heavy = "<p>a</p>" + "<script>" + "x".repeat(50) + "</script>".repeat(1) + "<div>b</div>".repeat(300)
    for (const maxNodes of [1, 2, 8, 64]) {
      expect(
        normalizeHtmlPasteWithinLimits({ html: heavy, plainText: "fallback" }, { maxDepth: 32, maxNodes }),
        `maxNodes ${maxNodes}`,
      ).toEqual(preparePlainTextFallback("fallback"))
    }
  })
})
