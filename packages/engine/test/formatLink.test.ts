import { describe, expect, it } from "vitest"
import { insertLink } from "../src/format/commands"
import { makeState } from "./helpers"
import { attempt, cursor, run, runOn } from "./formatHarness"

describe("insert link", () => {
  it("wraps a text selection and selects the empty url slot", () => {
    const next = run(insertLink, "read docs", { from: 0, to: 4 })
    expect(next.doc.toString()).toBe("[read]() docs")
    expect(cursor(next)).toEqual({ from: 7, to: 7 })
  })

  it("prefills the url when the selection is a URL and selects it", () => {
    const next = run(insertLink, "see https://example.com now", { from: 4, to: 23 })
    expect(next.doc.toString()).toBe("see [https://example.com](https://example.com) now")
    expect(cursor(next)).toEqual({ from: 26, to: 45 })
  })

  it("expands a bare autolink caret to the whole URL and wraps it once", () => {
    const doc = "see https://example.com now"
    const next = run(insertLink, doc, { from: 10 })
    expect(next.doc.toString()).toBe("see [https://example.com](https://example.com) now")
    expect(cursor(next)).toEqual({ from: 26, to: 45 })

    const partial = makeState(doc).update({
      selection: { anchor: 4, head: 11 },
    }).state
    const result = attempt(insertLink, partial)
    expect(result.handled).toBe(false)
    expect(result.next.doc.toString()).toBe(doc)
  })

  it("uses the word under a collapsed cursor", () => {
    const next = run(insertLink, "hello world", { from: 6 })
    expect(next.doc.toString()).toBe("hello [world]()")
    expect(cursor(next)).toEqual({ from: 14, to: 14 })
  })

  it("does not wrap an existing link when invoked again", () => {
    const on = run(insertLink, "hello world", { from: 6 })
    const off = runOn(insertLink, on)
    expect(off.doc.toString()).toBe("hello [world]()")
    expect(cursor(off)).toEqual({ from: 14, to: 14 })
  })

  it("selects the existing URL from link text or url", () => {
    const doc = "see [docs](https://example.test) now"
    const fromLabel = makeState(doc).update({
      selection: { anchor: doc.indexOf("docs") + 1 },
    }).state
    const labelResult = attempt(insertLink, fromLabel)
    expect(labelResult.next.doc.toString()).toBe(doc)
    expect(cursor(labelResult.next)).toEqual({
      from: doc.indexOf("https"),
      to: doc.indexOf("https") + "https://example.test".length,
    })

    const fromUrl = makeState(doc).update({
      selection: { anchor: doc.indexOf("example") },
    }).state
    const urlResult = attempt(insertLink, fromUrl)
    expect(urlResult.next.doc.toString()).toBe(doc)
    expect(cursor(urlResult.next)).toEqual(cursor(labelResult.next))
  })

  it("unlinks only when the whole Link node is selected", () => {
    const doc = "[docs](https://example.test)"
    const whole = run(insertLink, doc, { from: 0, to: doc.length })
    expect(whole.doc.toString()).toBe("docs")
    expect(cursor(whole)).toEqual({ from: 0, to: 4 })

    const partial = makeState(doc).update({
      selection: { anchor: 0, head: 13 },
    }).state
    expect(attempt(insertLink, partial).handled).toBe(false)
  })

  it("refuses images, verbatim, and cross-paragraph insertion", () => {
    const image = makeState("![alt](pic.png)").update({
      selection: { anchor: 2, head: 5 },
    }).state
    expect(attempt(insertLink, image).handled).toBe(false)

    const code = "```\ntext\n```"
    const fenced = makeState(code).update({
      selection: { anchor: code.indexOf("text"), head: code.indexOf("text") + 4 },
    }).state
    expect(attempt(insertLink, fenced).handled).toBe(false)

    const paragraphs = makeState("one\n\ntwo").update({
      selection: { anchor: 0, head: 8 },
    }).state
    expect(attempt(insertLink, paragraphs).handled).toBe(false)
  })

  it("fails closed for reference links and autolinks", () => {
    const reference = "see [text][ref] now\n\n[ref]: https://example.test"
    const insideReference = makeState(reference).update({
      selection: { anchor: reference.indexOf("text") },
    }).state
    const referenceResult = attempt(insertLink, insideReference)
    expect(referenceResult.handled).toBe(false)
    expect(referenceResult.next.doc.toString()).toBe(reference)

    const wholeReference = makeState(reference).update({
      selection: {
        anchor: reference.indexOf("[text]"),
        head: reference.indexOf("[text]") + "[text][ref]".length,
      },
    }).state
    expect(attempt(insertLink, wholeReference).handled).toBe(false)

    const autolink = "see <https://example.test> now"
    const insideAutolink = makeState(autolink).update({
      selection: { anchor: autolink.indexOf("example") },
    }).state
    const autolinkResult = attempt(insertLink, insideAutolink)
    expect(autolinkResult.handled).toBe(false)
    expect(autolinkResult.next.doc.toString()).toBe(autolink)

    const wholeAutolink = makeState(autolink).update({
      selection: { anchor: autolink.indexOf("<"), head: autolink.indexOf(">") + 1 },
    }).state
    expect(attempt(insertLink, wholeAutolink).handled).toBe(false)
  })
})
