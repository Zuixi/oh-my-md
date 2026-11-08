import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import {
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
  toggleUnderline,
} from "../src/format/commands"
import { makeState } from "./helpers"
import { attempt, cursor, run, runOn } from "./formatHarness"
import { markdownLanguageSupport } from "../src/parse/markdown"

function nodeNames(doc: string): string[] {
  const names: string[] = []
  syntaxTree(makeState(doc)).iterate({
    enter: node => {
      names.push(node.name)
    },
  })
  return names
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

  it("wraps underline and unwraps its asymmetric HTML markers", () => {
    const on = run(toggleUnderline, "text", { from: 0, to: 4 })
    expect(on.doc.toString()).toBe("<u>text</u>")
    const off = runOn(toggleUnderline, on)
    expect(off.doc.toString()).toBe("text")
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

  it("unwraps on the second press using the selection produced by the first press", () => {
    const on = run(toggleBold, "hello world", { from: 6 })
    expect(on.doc.toString()).toBe("hello **world**")
    const off = runOn(toggleBold, on)
    expect(off.doc.toString()).toBe("hello world")
    expect(cursor(off)).toEqual({ from: 6, to: 6 })
  })

  it("unwraps immediately on a large document even when formatting leaves a fragment hole", () => {
    const doc = `${Array.from({ length: 1_000 }, (_, index) => `format line ${index}`).join("\n")}\ntail`
    const on = run(toggleBold, doc, { from: doc.indexOf("tail") + 2 })
    expect(on.doc.toString().endsWith("\n**tail**")).toBe(true)

    const off = runOn(toggleBold, on)
    expect(off.doc.toString()).toBe(doc)
    expect(cursor(off)).toEqual({ from: doc.indexOf("tail") + 2, to: doc.indexOf("tail") + 2 })

    const onAgain = runOn(toggleBold, off)
    expect(onAgain.doc.toString().endsWith("\n**tail**")).toBe(true)
  })

  it("fails closed instead of inserting an unrecoverable empty marker pair", () => {
    const commands = [
      ["bold", toggleBold],
      ["italic", toggleItalic],
      ["strikethrough", toggleStrikethrough],
      ["inline-code", toggleInlineCode],
    ] as const
    for (const [name, command] of commands) {
      const doc = "text "
      const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
      const result = attempt(command, state)
      expect(result.handled, name).toBe(false)
      expect(result.next.doc.toString(), name).toBe(doc)
    }
  })

  it("rejects whitespace-only inline code", () => {
    const doc = "a b"
    const state = makeState(doc).update({
      selection: { anchor: 1, head: 2 },
    }).state
    const result = attempt(toggleInlineCode, state)
    expect(result.handled).toBe(false)
    expect(result.next.doc.toString()).toBe(doc)
  })

  it("does not emit emphasis delimiters that cannot open or close", () => {
    const commands = [
      ["bold", toggleBold],
      ["italic", toggleItalic],
      ["strikethrough", toggleStrikethrough],
    ] as const
    for (const [name, command] of commands) {
      const doc = "a  b"
      const state = makeState(doc).update({
        selection: { anchor: 1, head: 3 },
      }).state
      const result = attempt(command, state)
      expect(result.handled, name).toBe(false)
      expect(result.next.doc.toString(), name).toBe(doc)
    }

    const padded = "a text b"
    const paddedState = makeState(padded).update({
      selection: { anchor: 1, head: 7 },
    }).state
    expect(attempt(toggleBold, paddedState).handled).toBe(false)

    const rule = makeState("****").update({ selection: { anchor: 2 } }).state
    const ruleResult = attempt(toggleBold, rule)
    expect(ruleResult.handled).toBe(false)
    expect(ruleResult.next.doc.toString()).toBe("****")
  })

  it("wraps punctuation and emoji boundaries that produce real delimiter nodes", () => {
    const cases = [
      { doc: "text!", from: 0, to: 5, wrapped: "**text!**" },
      { doc: "!text", from: 0, to: 5, wrapped: "**!text**" },
      { doc: "😄", from: 0, to: 2, wrapped: "**😄**" },
    ] as const
    for (const { doc, from, to, wrapped } of cases) {
      const on = run(toggleBold, doc, { from, to })
      expect(on.doc.toString()).toBe(wrapped)
      expect(nodeNames(on.doc.toString())).toContain("StrongEmphasis")
      const off = runOn(toggleBold, on)
      expect(off.doc.toString()).toBe(doc)
    }
  })

  it("fails closed when a delimiter would merge with content or a neighboring marker", () => {
    const cases = [
      { doc: "*word", from: 0, to: 5 },
      { doc: "word*", from: 0, to: 5 },
      { doc: "a*word", from: 2, to: 6 },
      { doc: "word*a", from: 0, to: 4 },
    ] as const
    for (const { doc, from, to } of cases) {
      const state = makeState(doc).update({
        selection: { anchor: from, head: to },
      }).state
      const result = attempt(toggleBold, state)
      expect(result.handled, doc).toBe(false)
      expect(result.next.doc.toString(), doc).toBe(doc)
    }
  })

  it("reparses every wrapped marker as its semantic node and unwraps it", () => {
    const cases = [
      { command: toggleBold, node: "StrongEmphasis" },
      { command: toggleItalic, node: "Emphasis" },
      { command: toggleStrikethrough, node: "Strikethrough" },
      { command: toggleInlineCode, node: "InlineCode" },
      { command: toggleUnderline, node: "Underline" },
    ] as const
    for (const { command, node } of cases) {
      const on = run(command, "note", { from: 0, to: 4 })
      expect(nodeNames(on.doc.toString())).toContain(node)
      const off = runOn(command, on)
      expect(off.doc.toString()).toBe("note")
    }
  })

  it("treats native underscore delimiters as the same semantic emphasis", () => {
    expect(run(toggleBold, "__bold__ text", { from: 3 }).doc.toString()).toBe("bold text")
    expect(run(toggleItalic, "_italic_ text", { from: 2 }).doc.toString()).toBe("italic text")
  })

  it("unwraps only the requested level of nested emphasis", () => {
    const boldOff = run(toggleBold, "***text***", { from: 5 })
    expect(boldOff.doc.toString()).toBe("*text*")
    const italicOff = run(toggleItalic, "***text***", { from: 5 })
    expect(italicOff.doc.toString()).toBe("**text**")
  })

  it("stacks different emphasis dimensions without stacking the same one", () => {
    const bold = run(toggleBold, "text", { from: 0, to: 4 })
    const both = runOn(toggleItalic, bold)
    expect(both.doc.toString()).toBe("***text***")

    const boldOff = runOn(toggleBold, both)
    expect(boldOff.doc.toString()).toBe("*text*")
    const italicOff = runOn(toggleItalic, both)
    expect(italicOff.doc.toString()).toBe("**text**")

    const sameBold = runOn(toggleBold, bold)
    expect(sameBold.doc.toString()).toBe("text")
  })

  it("keeps native underscore emphasis valid when stacking the other dimension", () => {
    const both = run(toggleBold, "_text_", { from: 1, to: 5 })
    expect(both.doc.toString()).toBe("**_text_**")

    const boldOff = runOn(toggleBold, both)
    expect(boldOff.doc.toString()).toBe("_text_")
  })

  it("stacks non-code formatting around a whole inline-code node", () => {
    const code = run(toggleInlineCode, "text", { from: 0, to: 4 })
    const bold = runOn(toggleBold, code)
    expect(bold.doc.toString()).toBe("**`text`**")

    const boldOff = runOn(toggleBold, bold)
    expect(boldOff.doc.toString()).toBe("`text`")

    const underlined = runOn(toggleUnderline, code)
    expect(underlined.doc.toString()).toBe("<u>`text`</u>")
  })

  it("stacks bold around a whole underline node", () => {
    const underlined = run(toggleUnderline, "皆源于真", { from: 0, to: 4 })
    expect(cursor(underlined)).toEqual({ from: 3, to: 7 })
    const bold = runOn(toggleBold, underlined)
    expect(bold.doc.toString()).toBe("<u>**皆源于真**</u>")

    const boldOff = runOn(toggleBold, bold)
    expect(boldOff.doc.toString()).toBe("<u>皆源于真</u>")
  })

  it("composes every pair of distinct inline dimensions reversibly", () => {
    const dimensions = [
      ["bold", toggleBold],
      ["italic", toggleItalic],
      ["strikethrough", toggleStrikethrough],
      ["underline", toggleUnderline],
      ["inline-code", toggleInlineCode],
    ] as const
    const expected = new Map([
      ["bold+italic", "***text***"],
      ["bold+strikethrough", "~~**text**~~"],
      ["bold+underline", "<u>**text**</u>"],
      ["bold+inline-code", "**`text`**"],
      ["italic+bold", "***text***"],
      ["italic+strikethrough", "~~*text*~~"],
      ["italic+underline", "<u>*text*</u>"],
      ["italic+inline-code", "*`text`*"],
      ["strikethrough+bold", "**~~text~~**"],
      ["strikethrough+italic", "*~~text~~*"],
      ["strikethrough+underline", "<u>~~text~~</u>"],
      ["strikethrough+inline-code", "~~`text`~~"],
      ["underline+bold", "<u>**text**</u>"],
      ["underline+italic", "<u>*text*</u>"],
      ["underline+strikethrough", "<u>~~text~~</u>"],
      ["underline+inline-code", "<u>`text`</u>"],
      ["inline-code+bold", "**`text`**"],
      ["inline-code+italic", "*`text`*"],
      ["inline-code+strikethrough", "~~`text`~~"],
      ["inline-code+underline", "<u>`text`</u>"],
    ])

    for (const [firstName, firstCommand] of dimensions) {
      const first = run(firstCommand, "text", { from: 0, to: 4 })
      for (const [secondName, secondCommand] of dimensions) {
        if (firstName === secondName) continue
        const key = `${firstName}+${secondName}`
        const both = runOn(secondCommand, first)
        expect(both.doc.toString(), key).toBe(expected.get(key))
        const secondOff = runOn(secondCommand, both)
        expect(secondOff.doc.toString(), `${key} reversed`).toBe(first.doc.toString())
        const firstOff = runOn(firstCommand, secondOff)
        expect(firstOff.doc.toString(), `${key} fully reversed`).toBe("text")
      }
    }
  })

  it("wraps a collapsed cursor in a contiguous CJK run", () => {
    const cases = [
      ["bold", toggleBold, "**皆源于真**"],
      ["italic", toggleItalic, "*皆源于真*"],
      ["strikethrough", toggleStrikethrough, "~~皆源于真~~"],
      ["underline", toggleUnderline, "<u>皆源于真</u>"],
      ["inline-code", toggleInlineCode, "`皆源于真`"],
    ] as const
    for (const [name, command, wrapped] of cases) {
      const on = run(command, "皆源于真", { from: 2 })
      expect(on.doc.toString(), name).toBe(wrapped)
    }
  })

  it("unwraps every underline source shape accepted by the parser", () => {
    for (const doc of ["<U>text</U>", "<U>text</U >"]) {
      const off = run(toggleUnderline, doc, { from: 5 })
      expect(off.doc.toString(), doc).toBe("text")
    }
  })

  it("derives the inline-code delimiter from the longest backtick run", () => {
    const next = run(toggleInlineCode, "b``c", { from: 0, to: 4 })
    expect(next.doc.toString()).toBe("```b``c```")
    const off = runOn(toggleInlineCode, next)
    expect(off.doc.toString()).toBe("b``c")
  })

  it("fails closed when a selection only partly crosses a semantic inline node", () => {
    const state = makeState("hello **world**").update({
      selection: { anchor: 3, head: 10 },
    }).state
    const result = attempt(toggleBold, state)
    expect(result.handled).toBe(false)
    expect(result.next.doc.toString()).toBe("hello **world**")
  })

  it("refuses to wrap across paragraphs or verbatim regions", () => {
    const paragraphs = makeState("one\n\ntwo").update({
      selection: { anchor: 0, head: 8 },
    }).state
    expect(attempt(toggleBold, paragraphs).handled).toBe(false)

    const code = "```\nhello\n```"
    const fenced = makeState(code).update({
      selection: { anchor: code.indexOf("hello"), head: code.indexOf("hello") + 5 },
    }).state
    expect(attempt(toggleBold, fenced).handled).toBe(false)

    const math = "before $x + y$ after"
    const inlineMath = makeState(math).update({
      selection: { anchor: math.indexOf("x"), head: math.indexOf("+") },
    }).state
    expect(attempt(toggleItalic, inlineMath).handled).toBe(false)
  })

  it("fails closed when the syntax tree has not reached the selection", () => {
    // Keep this state detached: makeState would mount a view and force parsing,
    // which hides the progressive-parse contract these commands rely on.
    const doc = `${"lorem ipsum ".repeat(2_000)}tail`
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownLanguageSupport()],
    })
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)

    const result = attempt(toggleBold, state)
    expect(result.handled).toBe(false)
    expect(result.next.doc.toString()).toBe(doc)
  })
})
