import { describe, expect, it } from "vitest"
import { EditorState, type TransactionSpec } from "@codemirror/state"
import type { Command, EditorView } from "@codemirror/view"
import { makeState } from "./helpers"
import {
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleUnorderedList,
} from "../src/format/commands"

/** Runs a Command against a fresh state and returns the resulting state. */
function run(command: Command, doc: string, selection: { from: number; to?: number }): EditorState {
  const { from, to = from } = selection
  const state = makeState(doc).update({ selection: { anchor: from, head: to } }).state
  let next = state
  const target = {
    state,
    dispatch: (spec: TransactionSpec) => {
      next = state.update(spec).state
    },
  }
  const handled = command(target as unknown as EditorView)
  if (!handled) throw new Error("command was not handled")
  return next
}

function cursor(state: EditorState): { from: number; to: number } {
  const main = state.selection.main
  return { from: main.from, to: main.to }
}

describe("inline mark toggles", () => {
  it("wraps the word under a collapsed cursor in bold", () => {
    const next = run(toggleBold, "hello world", { from: 6 })
    expect(next.doc.toString()).toBe("hello **world**")
    expect(cursor(next)).toEqual({ from: 8, to: 8 })
  })

  it("unwraps an already-bold selection", () => {
    const next = run(toggleBold, "**bold** text", { from: 0, to: 8 })
    expect(next.doc.toString()).toBe("bold text")
    expect(cursor(next)).toEqual({ from: 0, to: 4 })
  })

  it("wraps a selection in italic", () => {
    const next = run(toggleItalic, "hello world", { from: 6, to: 11 })
    expect(next.doc.toString()).toBe("hello *world*")
    expect(cursor(next)).toEqual({ from: 7, to: 12 })
  })

  it("toggles strikethrough on and off", () => {
    const on = run(toggleStrikethrough, "note", { from: 0, to: 4 })
    expect(on.doc.toString()).toBe("~~note~~")
    const off = run(toggleStrikethrough, on.doc.toString(), { from: 0, to: 8 })
    expect(off.doc.toString()).toBe("note")
  })

  it("wraps inline code and unwraps single-backtick code", () => {
    const simple = run(toggleInlineCode, "run cmd", { from: 4, to: 7 })
    expect(simple.doc.toString()).toBe("run `cmd`")
    const unwrap = run(toggleInlineCode, "a `b` c", { from: 2, to: 5 })
    expect(unwrap.doc.toString()).toBe("a b c")
  })

  it("uses double backticks when the content itself contains a backtick", () => {
    const next = run(toggleInlineCode, "b`c", { from: 0, to: 3 })
    expect(next.doc.toString()).toBe("``b`c``")
  })

  it("keeps wrapped content selected after a non-empty toggle", () => {
    const next = run(toggleBold, "a text b", { from: 2, to: 6 })
    expect(next.doc.toString()).toBe("a **text** b")
    expect(cursor(next)).toEqual({ from: 4, to: 8 })
  })
})

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
})

describe("blockquote", () => {
  it("adds and removes a quote marker per line", () => {
    const doc = "one\ntwo"
    const on = run(toggleBlockquote, doc, { from: 0, to: doc.length })
    expect(on.doc.toString()).toBe("> one\n> two")
    const off = run(toggleBlockquote, on.doc.toString(), { from: 2, to: 9 })
    expect(off.doc.toString()).toBe("one\ntwo")
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
})

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

  it("uses the word under a collapsed cursor", () => {
    const next = run(insertLink, "hello world", { from: 6 })
    expect(next.doc.toString()).toBe("hello [world]()")
    expect(cursor(next)).toEqual({ from: 14, to: 14 })
  })
})
