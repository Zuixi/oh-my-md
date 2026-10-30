import { describe, expect, it } from "vitest"
import type { SyntaxNode } from "@lezer/common"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { linkParts } from "../src/semantic/link"
import { stringReferenceContext, type MarkdownReferenceContext } from "../src/semantic/references"

// Real configured parser (same inline parsers as the editor): accessors are
// always handed genuine Lezer nodes, never fixtures or mocks.
const parser = markdownLanguageSupport().language.parser

function requireNode(source: string, name: string, index = 0): SyntaxNode {
  const nodes: SyntaxNode[] = []
  parser.parse(source).iterate({
    enter(ref) {
      if (ref.name === name) nodes.push(ref.node)
    },
  })
  const node = nodes[index]
  if (!node) throw new Error(`no ${name} #${index} in ${JSON.stringify(source)}`)
  return node
}

function parts(source: string, name = "Link", index = 0) {
  return linkParts(requireNode(source, name, index), stringReferenceContext(source))
}

/**
 * Context over the whole fragment that fails as soon as the accessor slices
 * text outside the node it was given. Only `sliceString` is node-bounded:
 * `resolveReference` may legitimately resolve a definition elsewhere in the
 * document, so a reference resolving here proves no external slice was read.
 */
function boundedContext(source: string, node: SyntaxNode): MarkdownReferenceContext {
  const context = stringReferenceContext(source)
  return {
    sliceString(from, to) {
      if (from < node.from || to > node.to)
        throw new Error(`read [${from},${to}) outside node [${node.from},${node.to})`)
      return source.slice(from, to)
    },
    resolveReference: label => context.resolveReference(label),
  }
}

describe("linkParts", () => {
  it("reads an inline link's label text, destination and title", () => {
    const source = "[a &amp; \\*b\\* *c*](https://x.example \"t\")"
    const node = requireNode(source, "Link")
    expect(linkParts(node, stringReferenceContext(source))).toEqual({
      href: "https://x.example",
      title: "t",
      // Entity and Escape decode; emphasis marks are dropped, text kept.
      text: "a & *b* c",
      labelFrom: 1,
      labelTo: source.indexOf("]"),
      kind: "link",
    })
  })

  it("keeps a titleless inline link's title null", () => {
    expect(parts("[text](https://x.example)")).toEqual({
      href: "https://x.example",
      title: null,
      text: "text",
      labelFrom: 1,
      labelTo: 5,
      kind: "link",
    })
  })

  it("accepts every CommonMark title delimiter", () => {
    expect(parts("[t](u 'single')")?.title).toBe("single")
    expect(parts("[t](u (paren))")?.title).toBe("paren")
    expect(parts('[t](u "double")')?.title).toBe("double")
  })

  it("resolves a full reference link through the shared label lookup", () => {
    const source = "[ref][id]\n\n[id]: https://r.example \"RT\""
    expect(linkParts(requireNode(source, "Link"), stringReferenceContext(source))).toEqual({
      href: "https://r.example",
      title: "RT",
      text: "ref",
      labelFrom: 1,
      labelTo: 4,
      kind: "link",
    })
  })

  it("resolves a collapsed reference link by its own text", () => {
    const source = "[ref][]\n\n[ref]: https://c.example"
    expect(linkParts(requireNode(source, "Link"), stringReferenceContext(source))).toEqual({
      href: "https://c.example",
      title: null,
      text: "ref",
      labelFrom: 1,
      labelTo: 4,
      kind: "link",
    })
  })

  it("resolves a shortcut reference link", () => {
    const source = "[ref]\n\n[ref]: https://s.example"
    expect(linkParts(requireNode(source, "Link"), stringReferenceContext(source))).toEqual({
      href: "https://s.example",
      title: null,
      text: "ref",
      labelFrom: 1,
      labelTo: 4,
      kind: "link",
    })
  })

  it("matches reference labels case-insensitively", () => {
    const source = "[ref][ID]\n\n[id]: https://ci.example"
    expect(linkParts(requireNode(source, "Link"), stringReferenceContext(source))?.href).toBe(
      "https://ci.example",
    )
  })

  it("returns null for an unresolved full reference", () => {
    expect(parts("[x][missing]")).toBeNull()
  })

  it("returns null for an unresolved shortcut reference", () => {
    expect(parts("[x]")).toBeNull()
  })

  it("returns null for a node that is not a link", () => {
    const source = "*x*"
    expect(linkParts(requireNode(source, "Emphasis"), stringReferenceContext(source))).toBeNull()
  })

  it("normalizes an angle-bracket autolink, keeping its visible text", () => {
    const source = "<https://a.example/x>"
    const node = requireNode(source, "Autolink")
    expect(linkParts(node, stringReferenceContext(source))).toEqual({
      href: "https://a.example/x",
      title: null,
      text: "https://a.example/x",
      labelFrom: 1,
      labelTo: source.length - 1,
      kind: "autolink",
    })
  })

  it("normalizes an angle-bracket email autolink to mailto:", () => {
    expect(parts("<a@b.example>", "Autolink")).toEqual({
      href: "mailto:a@b.example",
      title: null,
      text: "a@b.example",
      labelFrom: 1,
      labelTo: 12,
      kind: "autolink",
    })
  })

  it("normalizes a bare www autolink to https:", () => {
    const source = "see www.example.com now"
    const node = requireNode(source, "Autolink")
    expect(linkParts(node, stringReferenceContext(source))).toEqual({
      href: "https://www.example.com",
      title: null,
      text: "www.example.com",
      labelFrom: 4,
      labelTo: 19,
      kind: "autolink",
    })
  })

  it("keeps a bare https autolink's destination and visible text unchanged", () => {
    const source = "see https://bare.example/x now"
    const node = requireNode(source, "Autolink")
    expect(linkParts(node, stringReferenceContext(source))).toEqual({
      href: "https://bare.example/x",
      title: null,
      text: "https://bare.example/x",
      labelFrom: 4,
      labelTo: 26,
      kind: "autolink",
    })
  })

  it("normalizes a bare email autolink to mailto:", () => {
    expect(parts("mail a@b.example now", "Autolink")).toEqual({
      href: "mailto:a@b.example",
      title: null,
      text: "a@b.example",
      labelFrom: 5,
      labelTo: 16,
      kind: "autolink",
    })
  })

  it("never reads outside the supplied bounded context", () => {
    // The definition lives outside the node, so a resolved reference proves the
    // lookup came from the context, not from slicing surrounding source.
    const source = "[x][missing]\n\n[missing]: https://elsewhere.example"
    const node = requireNode(source, "Link")
    expect(linkParts(node, boundedContext(source, node))).toEqual({
      href: "https://elsewhere.example",
      title: null,
      text: "x",
      labelFrom: 1,
      labelTo: 2,
      kind: "link",
    })

    const inline = "[a *b*](https://x.example \"t\")"
    const inlineNode = requireNode(inline, "Link")
    expect(linkParts(inlineNode, boundedContext(inline, inlineNode))?.text).toBe("a b")
  })
})
