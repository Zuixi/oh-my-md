import { beforeAll, describe, expect, it } from "vitest"
import {
  toggleBlockquote,
  toggleCodeBlock,
  toggleHeading,
  toggleOrderedList,
  toggleUnorderedList,
} from "../src/format/commands"
import { makeState } from "./helpers"
import { attempt, cursor, run, runOn } from "./formatHarness"
import { preloadMarkdownCodeLanguages } from "../src/parse/codeLanguages"

// A fence with an info string can use a lazily loaded nested language. Until
// that language is available CodeMirror deliberately leaves a fragment hole,
// so syntaxTreeAvailable correctly reports the region as incomplete.
beforeAll(() => preloadMarkdownCodeLanguages())

describe("headings", () => {
  it("sets a heading on a plain line and places the cursor after the marker", () => {
    const next = run(toggleHeading(2), "title", { from: 0 })
    expect(next.doc.toString()).toBe("## title")
    expect(cursor(next)).toEqual({ from: 3, to: 3 })
  })

  it("toggles the same level off", () => {
    const next = run(toggleHeading(2), "## title", { from: 3 })
    expect(next.doc.toString()).toBe("title")
  })

  it("changes level instead of stacking markers", () => {
    const next = run(toggleHeading(1), "## title", { from: 3 })
    expect(next.doc.toString()).toBe("# title")
  })

  it("applies to every selected line", () => {
    const doc = "one\ntwo\nthree"
    const next = run(toggleHeading(3), doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("### one\n### two\n### three")
  })

  it("normalizes a mixed selection to the target level instead of toggling each line", () => {
    const doc = "## one\ntwo\n### three"
    const on = run(toggleHeading(2), doc, { from: 0, to: doc.length })
    expect(on.doc.toString()).toBe("## one\n## two\n## three")
    const off = runOn(toggleHeading(2), on)
    expect(off.doc.toString()).toBe("one\ntwo\nthree")
  })

  it("writes heading prefixes at content start inside containers", () => {
    const doc = "> one\n> two"
    const next = run(toggleHeading(2), doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("> ## one\n> ## two")
  })

  it("fails closed for Setext headings and block-verbatim content", () => {
    const setext = makeState("title\n=====").update({
      selection: { anchor: 0, head: 11 },
    }).state
    expect(attempt(toggleHeading(2), setext).handled).toBe(false)

    const fenced = "```\n# code\n```"
    const inCode = makeState(fenced).update({
      selection: { anchor: fenced.indexOf("#"), head: fenced.indexOf("code") },
    }).state
    expect(attempt(toggleHeading(2), inCode).handled).toBe(false)
  })
})

describe("lists", () => {
  it("toggles an unordered list on and off", () => {
    const on = run(toggleUnorderedList, "item", { from: 0, to: 4 })
    expect(on.doc.toString()).toBe("- item")
    const off = run(toggleUnorderedList, "- item", { from: 2, to: 6 })
    expect(off.doc.toString()).toBe("item")
  })

  it("numbers ordered list lines sequentially", () => {
    const doc = "one\ntwo"
    const next = run(toggleOrderedList, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("1. one\n2. two")
  })

  it("continues numbering after an existing ordered list", () => {
    const doc = "1. first\nsecond"
    const next = run(toggleOrderedList, doc, { from: doc.indexOf("second") })
    expect(next.doc.toString()).toBe("1. first\n2. second")
  })

  it("replaces an ordered marker with a bullet", () => {
    const next = run(toggleUnorderedList, "1. item", { from: 3 })
    expect(next.doc.toString()).toBe("- item")
  })

  it("removes ordered markers when toggled off", () => {
    const next = run(toggleOrderedList, "1. one\n2. two", { from: 0, to: 12 })
    expect(next.doc.toString()).toBe("one\ntwo")
  })

  it("normalizes a mixed selection to the target list type", () => {
    const doc = "- one\ntwo\n1. three"
    const on = run(toggleUnorderedList, doc, { from: 0, to: doc.length })
    expect(on.doc.toString()).toBe("- one\n- two\n- three")
    const off = runOn(toggleUnorderedList, on)
    expect(off.doc.toString()).toBe("one\ntwo\nthree")
  })

  it("writes list markers at content start inside quotes", () => {
    const doc = "> one\n> two"
    const next = run(toggleUnorderedList, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("> - one\n> - two")
  })

  it("numbers converted lines while preserving already ordered siblings", () => {
    const doc = "1. one\ntwo\nthree"
    const next = run(toggleOrderedList, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("1. one\n2. two\n3. three")
  })

  it("fails closed inside code blocks", () => {
    const doc = "```\n- code\n```"
    const state = makeState(doc).update({
      selection: { anchor: doc.indexOf("-"), head: doc.indexOf("code") },
    }).state
    expect(attempt(toggleUnorderedList, state).handled).toBe(false)
  })
})

describe("blockquote", () => {
  it("adds and removes a quote marker per line", () => {
    const doc = "one\ntwo"
    const on = run(toggleBlockquote, doc, { from: 0, to: doc.length })
    expect(on.doc.toString()).toBe("> one\n> two")
    const off = run(toggleBlockquote, on.doc.toString(), { from: 2, to: 9 })
    expect(off.doc.toString()).toBe("one\ntwo")
  })

  it("recognizes quote forms that startsWith('> ') used to miss", () => {
    expect(run(toggleBlockquote, ">x", { from: 2 }).doc.toString()).toBe("x")
    expect(run(toggleBlockquote, "  > x", { from: 5 }).doc.toString()).toBe("  x")
    expect(run(toggleBlockquote, "- > x", { from: 5 }).doc.toString()).toBe("- x")
    expect(run(toggleBlockquote, "> - x", { from: 5 }).doc.toString()).toBe("- x")
  })

  it("removes one nesting level and keeps the content indentation", () => {
    expect(run(toggleBlockquote, "> > x", { from: 5 }).doc.toString()).toBe("> x")
    expect(run(toggleBlockquote, "  >   x", { from: 7 }).doc.toString()).toBe("    x")
  })

  it("quotes every line when any line in the selection is unquoted", () => {
    const doc = "> one\ntwo"
    const next = run(toggleBlockquote, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("> one\n> two")
  })

  it("quotes a list line without breaking the list", () => {
    const next = run(toggleBlockquote, "- item", { from: 6 })
    expect(next.doc.toString()).toBe("> - item")
  })

  it("fails closed inside block-verbatim and table hosts", () => {
    const cases = [
      "```\ncode\n```",
      "$$\nx + y\n$$",
      "---\ntitle: x\n---",
      "| a |\n| - |\n| b |",
    ]
    for (const doc of cases) {
      const probe = doc.includes("code")
        ? doc.indexOf("code")
        : doc.includes("+")
          ? doc.indexOf("x")
          : doc.includes("title")
            ? doc.indexOf("x")
            : doc.indexOf("b")
      const state = makeState(doc).update({ selection: { anchor: probe } }).state
      const result = attempt(toggleBlockquote, state)
      expect(result.handled, doc).toBe(false)
      expect(result.next.doc.toString(), doc).toBe(doc)
    }
  })
})

describe("code block", () => {
  it("wraps a multi-line selection in fences", () => {
    const doc = "line one\nline two"
    const next = run(toggleCodeBlock, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("```\nline one\nline two\n```")
  })

  it("unwraps an already fenced selection", () => {
    const doc = "```\ncode\n```"
    const next = run(toggleCodeBlock, doc, { from: 0, to: doc.length })
    expect(next.doc.toString()).toBe("code")
  })

  it("wraps the paragraph under a collapsed cursor", () => {
    const doc = "para one\npara two"
    const next = run(toggleCodeBlock, doc, { from: 2 })
    expect(next.doc.toString()).toBe("```\npara one\npara two\n```")
  })

  it("wraps only the Lezer paragraph when adjacent to a $$ math block without a blank line", () => {
    const doc = "intro\n$$E=mc^2$$"
    const next = run(toggleCodeBlock, doc, { from: 2 })
    expect(next.doc.toString()).toBe("```\nintro\n```\n$$E=mc^2$$")
  })

  it("round-trips through the selection produced by wrapping", () => {
    const doc = "line one\nline two"
    const on = run(toggleCodeBlock, doc, { from: 0, to: doc.length })
    expect(on.doc.toString()).toBe("```\nline one\nline two\n```")
    const off = runOn(toggleCodeBlock, on)
    expect(off.doc.toString()).toBe(doc)
    expect(cursor(off)).toEqual({ from: 0, to: doc.length })
  })

  it("round-trips when the collapsed caret starts at the paragraph end", () => {
    const doc = "line one\nline two"
    const on = run(toggleCodeBlock, doc, { from: doc.length })
    expect(on.doc.toString()).toBe("```\nline one\nline two\n```")
    expect(cursor(on)).toEqual({ from: 21, to: 21 })

    const off = runOn(toggleCodeBlock, on)
    expect(off.doc.toString()).toBe(doc)
    expect(cursor(off)).toEqual({ from: doc.length, to: doc.length })
  })

  it("unwraps from a caret inside a closed or unclosed fence", () => {
    const closed = "```js title\ncode\n```"
    const insideClosed = makeState(closed).update({
      selection: { anchor: closed.indexOf("code") + 2 },
    }).state
    expect(runOn(toggleCodeBlock, insideClosed).doc.toString()).toBe("code")

    const open = "```\ncode"
    const insideOpen = makeState(open).update({
      selection: { anchor: open.indexOf("code") + 2 },
    }).state
    expect(runOn(toggleCodeBlock, insideOpen).doc.toString()).toBe("code")
  })

  it("refuses cross-container, indented-code, math, front-matter, and table hosts", () => {
    const cases = [
      "> ```\n> code\n> ```",
      "- ```\n  code\n  ```",
      "    indented code",
      "$$\nx + y\n$$",
      "---\ntitle: x\n---",
      "| a |\n| - |\n| b |",
    ]
    for (const doc of cases) {
      const probe = doc.includes("code")
        ? doc.indexOf("code")
        : doc.includes(" + ")
          ? doc.indexOf("+")
          : doc.includes("title")
            ? doc.indexOf("x")
            : doc.indexOf("b")
      const state = makeState(doc).update({ selection: { anchor: probe } }).state
      const result = attempt(toggleCodeBlock, state)
      expect(result.handled, doc).toBe(false)
      expect(result.next.doc.toString(), doc).toBe(doc)
    }
  })
})
