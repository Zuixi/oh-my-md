import { describe, expect, it } from "vitest"
import { CompletionContext } from "@codemirror/autocomplete"
import { syntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { collectDecorationSpecs } from "../src/decorations/build"
import { editorExtensions } from "../src/index"
import { emojiCompletions } from "../src/parse/emojiComplete"
import { resolveEmoji } from "../src/parse/emoji"
import { makeState } from "./helpers"

function nodeNames(doc: string) {
  const names: string[] = []
  syntaxTree(makeState(doc)).iterate({ enter: n => { names.push(n.name) } })
  return names
}

function tagsOffLine(doc: string) {
  const full = `${doc}\nx`
  const state = makeState(full).update({ selection: { anchor: full.length } }).state
  return collectDecorationSpecs(state, 0, state.doc.length)
}

function complete(doc: string, pos = doc.length) {
  const state = EditorState.create({ doc, extensions: editorExtensions() })
  return emojiCompletions(new CompletionContext(state, pos, true))
}

describe("github emoji shortcodes", () => {
  it("resolves gemoji aliases to unicode and skips custom names", () => {
    expect(resolveEmoji("smile")).toBe("😄")
    expect(resolveEmoji("tada")).toBe("🎉")
    expect(resolveEmoji("+1")).toBe("👍")
    expect(resolveEmoji("octocat")).toBeNull()
    expect(resolveEmoji("not_an_emoji")).toBeNull()
  })

  it("parses known shortcodes and leaves unknown or coded text alone", () => {
    expect(nodeNames("ship it :tada: now")).toContain("Emoji")
    expect(nodeNames("see :not_an_emoji: here")).not.toContain("Emoji")
    expect(nodeNames("meet 12:00-14:00")).not.toContain("Emoji")
    expect(nodeNames("`:tada:`")).not.toContain("Emoji")
    expect(nodeNames("\\:tada:")).not.toContain("Emoji")
  })

  it("preview-replaces a known shortcode and unfolds when the cursor is inside", () => {
    const doc = "celebrate :tada: please"
    const away = tagsOffLine(doc)
      .filter(d => d.tag === "widget:emoji")
      .map(d => (d.deco.spec.widget as { ch: string }).ch)
    expect(away).toEqual(["🎉"])

    const inside = doc.indexOf("tada")
    const state = makeState(doc).update({ selection: { anchor: inside } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(tags).not.toContain("widget:emoji")
  })

  it("suggests gemoji after ':' and applies unicode, not the shortcode", () => {
    const result = complete(":smi")
    expect(result).not.toBeNull()
    const smile = result?.options.find(option => option.label === ":smile:")
    expect(smile?.apply).toBe("😄")
    expect(result?.from).toBe(0)
  })

  it("does not complete inside a time, a word, or inline code", () => {
    expect(complete("12:00")).toBeNull()
    expect(complete("hello:smi")).toBeNull()
    expect(complete("see `:smi` now", "see `:smi".length)).toBeNull()
  })
})
