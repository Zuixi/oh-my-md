import { beforeEach, describe, expect, it } from "vitest"
import { Compartment, EditorState } from "@codemirror/state"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import type { Tree } from "@lezer/common"
import { markdownLanguageSupport } from "../src/parse/markdown"
import {
  editorReferenceContext,
  referenceIndexExtension,
  referenceIndexScanStats,
  snapshotReferenceContext,
  stringReferenceContext,
} from "../src/semantic/references"

function makeState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [markdownLanguageSupport(), referenceIndexExtension],
  })
}

function topLevelBlocks(tree: Tree): number {
  let count = 0
  tree.iterate({
    enter(node) {
      if (node.name === "Document") return
      if (node.node.parent?.name === "Document") count++
      return false
    },
  })
  return count
}

beforeEach(() => {
  referenceIndexScanStats.reset()
})

describe("stringReferenceContext", () => {
  it("resolves double, single and parenthesized titles", () => {
    const ctx = stringReferenceContext(
      '[a]: a.png "double"\n[b]: b.png \'single\'\n[c]: c.png (paren)\n[d]: d.png\n',
    )
    expect(ctx.resolveReference("[a]")).toEqual({ href: "a.png", title: "double" })
    expect(ctx.resolveReference("b")).toEqual({ href: "b.png", title: "single" })
    expect(ctx.resolveReference("[c]")).toEqual({ href: "c.png", title: "paren" })
    expect(ctx.resolveReference("[d]")).toEqual({ href: "d.png", title: null })
  })

  it("normalizes bracket, whitespace and case variants of a label", () => {
    const ctx = stringReferenceContext("[Foo  Bar]: img.png\n")
    const expected = { href: "img.png", title: null }
    expect(ctx.resolveReference("[Foo  Bar]")).toEqual(expected)
    expect(ctx.resolveReference("foo bar")).toEqual(expected)
    expect(ctx.resolveReference("[ FOO\tBAR ]")).toEqual(expected)
    expect(ctx.resolveReference("[missing]")).toBeNull()
  })

  it("resolves full, collapsed and shortcut label forms", () => {
    const ctx = stringReferenceContext("![a][id] and [id][] and [ID]\n\n[id]: node.png\n")
    // Confirmed label forms a link/image layer passes in: `[id]`, `id`, `ID`.
    expect(ctx.resolveReference("[id]")).toEqual({ href: "node.png", title: null })
    expect(ctx.resolveReference("id")).toEqual({ href: "node.png", title: null })
    expect(ctx.resolveReference("ID")).toEqual({ href: "node.png", title: null })
    // A collapsed `[]` label carries no key of its own.
    expect(ctx.resolveReference("[]")).toBeNull()
  })

  it("keeps the first definition for duplicate labels", () => {
    const ctx = stringReferenceContext("[id]: first.png\n\n[id]: second.png\n")
    expect(ctx.resolveReference("[id]")).toEqual({ href: "first.png", title: null })
  })

  it("unwraps an angle-bracketed destination", () => {
    const ctx = stringReferenceContext("[spaced]: <a b.png> 'til te'\n")
    expect(ctx.resolveReference("[spaced]")).toEqual({ href: "a b.png", title: "til te" })
  })

  it("reads label text from the supplied fragment", () => {
    const ctx = stringReferenceContext("![ref][id]\n\n[id]: img.png\n")
    expect(ctx.sliceString(0, 5)).toBe("![ref")
    expect(ctx.resolveReference("[id]")).toEqual({ href: "img.png", title: null })
  })
})

describe("snapshotReferenceContext", () => {
  it("resolves definitions from a read-only state snapshot", () => {
    const state = makeState("[ref]: img.png \"caption\"\n")
    expect(syntaxTree(state).length).toBe(state.doc.length)
    const ctx = snapshotReferenceContext(state)
    expect(ctx.resolveReference("[REF]")).toEqual({ href: "img.png", title: "caption" })
    expect(ctx.sliceString(0, 5)).toBe("[ref]")
  })

  it("leaves definitions beyond the parsed prefix unresolved", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `paragraph ${i} body\n\n`).join("")
    const state = EditorState.create({
      doc: `${filler}[id]: a.png\n`,
      extensions: [markdownLanguageSupport()],
    })
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length)
    expect(snapshotReferenceContext(state).resolveReference("[id]")).toBeNull()
  })
})

describe("editorReferenceContext", () => {
  it("resolves definitions through the installed index", () => {
    const state = makeState("![pic][id]\n\n[id]: img.png \"t\"\n")
    expect(editorReferenceContext(state).resolveReference("[id]")).toEqual({
      href: "img.png",
      title: "t",
    })
  })

  it("refreshes resolution when a definition changes or disappears", () => {
    const doc = "![pic][id]\n\n[id]: img.png \"t\"\n"
    const state = makeState(doc)
    const defFrom = doc.indexOf("[id]: ")

    const retitled = state.update({
      changes: { from: doc.indexOf("img.png"), to: doc.indexOf("img.png") + 7, insert: "other.png" },
    }).state
    expect(editorReferenceContext(retitled).resolveReference("[id]")).toEqual({
      href: "other.png",
      title: "t",
    })

    const removed = retitled.update({ changes: { from: defFrom, to: doc.length } }).state
    expect(editorReferenceContext(removed).resolveReference("[id]")).toBeNull()
  })

  it("falls back to first-definition precedence after the first duplicate is deleted", () => {
    const doc = "[id]: first.png\n\n[id]: second.png\n"
    const state = makeState(doc)
    expect(editorReferenceContext(state).resolveReference("[id]")).toEqual({
      href: "first.png",
      title: null,
    })

    const after = state.update({ changes: { from: 0, to: "[id]: first.png\n\n".length } }).state
    expect(editorReferenceContext(after).resolveReference("[id]")).toEqual({
      href: "second.png",
      title: null,
    })
  })

  it("keeps the resolver identity and reads fresh slices for text-only edits", () => {
    const doc = "![a][id]\n\nbody text\n\n[id]: img.png\n"
    const state = makeState(doc)
    const before = editorReferenceContext(state)
    const pos = doc.indexOf("body text") + 2
    const after = editorReferenceContext(state.update({ changes: { from: pos, insert: "XY" } }).state)

    expect(after.resolveReference).toBe(before.resolveReference)
    expect(after.resolveReference("[id]")).toEqual({ href: "img.png", title: null })
    expect(after.sliceString(0, 14)).toBe("![a][id]\n\nboXY")
  })

  it("re-seeds after the extension is replaced like a source/live toggle", () => {
    const slot = new Compartment()
    const base = [markdownLanguageSupport()]
    const state = EditorState.create({
      doc: "[id]: a.png\n",
      extensions: [...base, slot.of(referenceIndexExtension)],
    })
    expect(editorReferenceContext(state).resolveReference("[id]")).toEqual({
      href: "a.png",
      title: null,
    })

    const withoutIndex = state.update({ effects: slot.reconfigure([]) }).state
    expect(editorReferenceContext(withoutIndex).resolveReference("[id]")).toEqual({
      href: "a.png",
      title: null,
    })

    const changed = withoutIndex.update({
      changes: { from: 0, to: "[id]: a.png".length, insert: "[id]: b.png" },
    }).state
    const restored = changed.update({ effects: slot.reconfigure(referenceIndexExtension) }).state
    const ctx = editorReferenceContext(restored)
    expect(ctx.resolveReference("[id]")).toEqual({ href: "b.png", title: null })
    expect(ctx.sliceString(0, 10)).toBe("[id]: b.pn")
  })

  it("rescans only the edited top-level blocks", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `paragraph ${i}\n\n`).join("")
    const doc = `![pic][id]\n\n${paragraphs}[id]: a.png\n`
    const state = makeState(doc)
    expect(syntaxTree(state).length).toBe(doc.length)
    const blocks = topLevelBlocks(syntaxTree(state))
    expect(referenceIndexScanStats.scannedBlocks).toBe(blocks)

    referenceIndexScanStats.reset()
    const pos = doc.indexOf("paragraph 5") + 3
    const after = state.update({ changes: { from: pos, insert: "X" } }).state

    expect(referenceIndexScanStats.scannedBlocks).toBe(1)
    expect(editorReferenceContext(after).resolveReference).toBe(
      editorReferenceContext(state).resolveReference,
    )
  })

  it("indexes the parsed prefix and grows with the tree instead of rescanning", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `paragraph ${i} body\n\n`).join("")
    const doc = `${filler}[id]: a.png\n`
    const state = makeState(doc)
    expect(syntaxTree(state).length).toBeLessThan(doc.length)
    expect(referenceIndexScanStats.scannedBlocks).toBeGreaterThan(0)
    expect(referenceIndexScanStats.scannedBlocks).toBeLessThan(400)
    expect(editorReferenceContext(state).resolveReference("[id]")).toBeNull()

    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    forceParsing(view, doc.length, 10000)
    const complete = view.state
    view.destroy()
    parent.remove()

    expect(syntaxTree(complete).length).toBe(doc.length)
    expect(editorReferenceContext(complete).resolveReference("[id]")).toEqual({
      href: "a.png",
      title: null,
    })
    expect(referenceIndexScanStats.scannedBlocks).toBeLessThanOrEqual(
      topLevelBlocks(syntaxTree(complete)) + 2,
    )
  })
})
