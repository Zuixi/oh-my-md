import { describe, expect, it } from "vitest"
import type { SyntaxNode } from "@lezer/common"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { imageParts } from "../src/semantic/image"
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

function parts(source: string, name = "Image", index = 0) {
  return imageParts(requireNode(source, name, index), stringReferenceContext(source))
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

describe("imageParts", () => {
  const cases = [
    { source: "![plain](a.png)", alt: "plain", src: "a.png", title: null },
    { source: "![a *b* &amp; c](a.png \"caption\")", alt: "a b & c", src: "a.png", title: "caption" },
    { source: "![ref][id]\n\n[id]: img.png \"title\"", alt: "ref", src: "img.png", title: "title" },
    { source: "![](empty.png)", alt: "", src: "empty.png", title: null },
  ]

  for (const { source, alt, src, title } of cases) {
    it(`reads ${JSON.stringify(source)}`, () => {
      expect(imageParts(requireNode(source, "Image"), stringReferenceContext(source))).toEqual({
        alt,
        src,
        title,
      })
    })
  }

  it("resolves a collapsed reference image by its own alt text", () => {
    const source = "![ref][]\n\n[ref]: c.png"
    expect(imageParts(requireNode(source, "Image"), stringReferenceContext(source))).toEqual({
      alt: "ref",
      src: "c.png",
      title: null,
    })
  })

  it("resolves a shortcut reference image", () => {
    const source = "![ref]\n\n[ref]: s.png"
    expect(imageParts(requireNode(source, "Image"), stringReferenceContext(source))).toEqual({
      alt: "ref",
      src: "s.png",
      title: null,
    })
  })

  it("matches reference labels case-insensitively", () => {
    const source = "![Ref][ID]\n\n[id]: ci.png"
    expect(imageParts(requireNode(source, "Image"), stringReferenceContext(source))).toEqual({
      alt: "Ref",
      src: "ci.png",
      title: null,
    })
  })

  it("keeps an empty alt empty", () => {
    expect(parts("![](empty.png)")?.alt).toBe("")
  })

  it("returns null for an unresolved reference image", () => {
    expect(parts("![x][missing]")).toBeNull()
  })

  it("returns null for a shortcut reference image without a definition", () => {
    expect(parts("![x]")).toBeNull()
  })

  it("returns null for a node that is not an image", () => {
    const source = "[a](u)"
    expect(imageParts(requireNode(source, "Link"), stringReferenceContext(source))).toBeNull()
  })

  it("never reads outside the supplied bounded context", () => {
    // The definition lives outside the node, so a resolved reference proves the
    // lookup came from the context, not from slicing surrounding source.
    const source = "![x][missing]\n\n[missing]: https://elsewhere.example"
    const node = requireNode(source, "Image")
    expect(imageParts(node, boundedContext(source, node))).toEqual({
      alt: "x",
      src: "https://elsewhere.example",
      title: null,
    })

    const inline = "![a *b*](a.png)"
    const inlineNode = requireNode(inline, "Image")
    expect(imageParts(inlineNode, boundedContext(inline, inlineNode))).toEqual({
      alt: "a b",
      src: "a.png",
      title: null,
    })
  })
})
