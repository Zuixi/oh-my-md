import { describe, expect, it, vi } from "vitest"
import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete"
import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { collectDecorationSpecs } from "../src/decorations/build"
import { editorExtensions } from "../src/index"
import { emojiCompletions } from "../src/parse/emojiComplete"

// @codemirror/autocomplete ignores accept/close keys for its default 75 ms
// interaction delay after a list opens. Wait past that threshold only after
// observing the active result, never as a proxy for "completion has opened".
const COMPLETION_KEY_DELAY_MS = 100
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

function mount(doc: string, head = doc.length) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [keymap.of([...defaultKeymap, ...historyKeymap]), editorExtensions()],
    }),
    parent,
  })
  forceParsing(view, doc.length, 10_000)
  return { view, cleanup: () => { view.destroy(); parent.remove() } }
}

function press(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

async function settleCompletions(view: EditorView) {
  startCompletion(view)
  await vi.waitFor(() => {
    expect(completionStatus(view.state)).not.toBe("pending")
  }, { timeout: 3_000, interval: 20 })
}

async function openCompletions(view: EditorView) {
  await settleCompletions(view)
  expect(completionStatus(view.state)).toBe("active")
  expect(currentCompletions(view.state).length).toBeGreaterThan(0)
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

  it("does not offer completions for a closed shortcode", () => {
    expect(complete(":smile:")).toBeNull()
    expect(complete("say :smile: now", "say :smile:".length)).toBeNull()
  })

  it("does not complete inside front matter, math blocks, or inline math", () => {
    expect(complete("---\ntitle: :smi\n---", "---\ntitle: :smi".length)).toBeNull()
    expect(complete("$$\n:smi\n$$", "$$\n:smi".length)).toBeNull()
    expect(complete("before $:smi$ after", "before $:smi".length)).toBeNull()
  })

  it("lets Enter insert a newline after a closed shortcode instead of accepting", async () => {
    const doc = "say :smile:"
    const { view, cleanup } = mount(doc)
    try {
      await settleCompletions(view)
      expect(completionStatus(view.state)).toBeNull()
      press(view, "Enter")
      expect(view.state.doc.toString()).toBe(`${doc}\n`)
      expect(view.state.selection.main.head).toBe(doc.length + 1)
    } finally {
      cleanup()
    }
  })

  it("still completes an unclosed shortcode and accepts it with Enter", async () => {
    const doc = "say :tada"
    const { view, cleanup } = mount(doc)
    try {
      await openCompletions(view)
      await new Promise(resolve => setTimeout(resolve, COMPLETION_KEY_DELAY_MS))
      press(view, "Enter")
      expect(view.state.doc.toString()).toBe("say 🎉")
    } finally {
      cleanup()
    }
  })

  it("invalidates an open completion when the shortcode closes", async () => {
    const doc = "say :tada"
    const { view, cleanup } = mount(doc)
    try {
      await openCompletions(view)
      view.dispatch({
        changes: { from: doc.length, insert: ":" },
        selection: { anchor: doc.length + 1 },
        userEvent: "input.type",
      })
      await vi.waitFor(() => {
        expect(completionStatus(view.state)).toBeNull()
      }, { timeout: 3_000, interval: 20 })

      press(view, "Enter")
      expect(view.state.doc.toString()).toBe("say :tada:\n")
    } finally {
      cleanup()
    }
  })
})
