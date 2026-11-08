import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"

// These tests intentionally go through a mounted EditorView and the same keymap
// order as apps/desktop/src/Editor.ts. A headless EditorState update can hide
// both parse timing and history annotation behavior.

function mount(doc: string, anchor = doc.length, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editorExtensions(),
        ...extra,
      ],
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  return {
    view,
    cleanup: () => {
      view.destroy()
      parent.remove()
    },
  }
}

function press(
  view: EditorView,
  key: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; keyCode?: number } = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: modifiers.ctrlKey ?? true,
    shiftKey: modifiers.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  })
  // Real keyboard events carry a keyCode. CodeMirror relies on it to recover
  // the unshifted key when Shift turns "k" into "K"; synthetic KeyboardEvent
  // leaves keyCode at 0 unless explicitly defined.
  if (modifiers.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: modifiers.keyCode })
  }
  view.contentDOM.dispatchEvent(event)
}

function nodeNames(view: EditorView): string[] {
  const names: string[] = []
  syntaxTree(view.state).iterate({ enter: node => { names.push(node.name) } })
  return names
}

describe("formatting shortcuts in a real editor", () => {
  it("unwraps on the second Ctrl+B press immediately after the first", () => {
    const { view, cleanup } = mount("hello world", 6)
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello **world**")
      expect(view.state.selection.main.head).toBe(8)
      expect(nodeNames(view)).toContain("StrongEmphasis")

      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello world")
      expect(view.state.selection.main.head).toBe(6)
    } finally {
      cleanup()
    }
  })

  it("unwraps on the second Ctrl+B press when the caret starts at the word end", () => {
    const { view, cleanup } = mount("hello world", 11)
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello **world**")
      expect(view.state.selection.main.head).toBe(13)

      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello world")
      expect(view.state.selection.main.head).toBe(11)
    } finally {
      cleanup()
    }
  })

  it("stacks different emphasis dimensions and removes only the requested one", () => {
    const { view, cleanup } = mount("text", 0)
    try {
      view.dispatch({ selection: { anchor: 0, head: 4 } })
      press(view, "b")
      expect(view.state.doc.toString()).toBe("**text**")

      press(view, "i")
      expect(view.state.doc.toString()).toBe("***text***")

      press(view, "b")
      expect(view.state.doc.toString()).toBe("*text*")

      press(view, "i")
      expect(view.state.doc.toString()).toBe("text")
    } finally {
      cleanup()
    }
  })

  it("binds Ctrl+U and composes non-code formatting around inline code", () => {
    const { view, cleanup } = mount("text", 0)
    try {
      view.dispatch({ selection: { anchor: 0, head: 4 } })
      press(view, "u")
      expect(view.state.doc.toString()).toBe("<u>text</u>")
      expect(nodeNames(view)).toContain("Underline")

      press(view, "z")
      expect(view.state.doc.toString()).toBe("text")

      press(view, "`")
      expect(view.state.doc.toString()).toBe("`text`")
      press(view, "b")
      expect(view.state.doc.toString()).toBe("**`text`**")
    } finally {
      cleanup()
    }
  })

  it("uses one undo step for one formatting command", () => {
    const { view, cleanup } = mount("hello world", 6)
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello **world**")

      press(view, "z")
      expect(view.state.doc.toString()).toBe("hello world")
    } finally {
      cleanup()
    }
  })

  it("keeps consecutive formatting commands as separate undo steps", () => {
    const { view, cleanup } = mount("one two", 1)
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe("**one** two")

      view.dispatch({ selection: { anchor: 8, head: 11 } })
      press(view, "i")
      expect(view.state.doc.toString()).toBe("**one** *two*")

      press(view, "z")
      expect(view.state.doc.toString()).toBe("**one** two")
      press(view, "z")
      expect(view.state.doc.toString()).toBe("one two")
    } finally {
      cleanup()
    }
  })

  it("lets formatting shortcuts win over generic host bindings", () => {
    const { view, cleanup } = mount("hello world", 6)
    try {
      press(view, "i")
      expect(view.state.doc.toString()).toBe("hello *world*")

      press(view, "z")
      expect(view.state.doc.toString()).toBe("hello world")

      press(view, "K", { shiftKey: true, keyCode: 75 })
      expect(view.state.doc.toString()).toBe("```\nhello world\n```")
    } finally {
      cleanup()
    }
  })

  it("does not swallow typed input into the formatting undo step", () => {
    const { view, cleanup } = mount("hello world", 11)
    try {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "!" },
        selection: { anchor: view.state.doc.length + 1 },
        userEvent: "input.type",
      })
      expect(view.state.doc.toString()).toBe("hello world!")

      view.dispatch({ selection: { anchor: 6, head: 11 } })
      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello **world**!")

      press(view, "z")
      expect(view.state.doc.toString()).toBe("hello world!")
    } finally {
      cleanup()
    }
  })

  it("leaves fenced code content unchanged", () => {
    const doc = "```\nhello\n```"
    const { view, cleanup } = mount(doc, doc.indexOf("hello") + 2)
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe(doc)
    } finally {
      cleanup()
    }
  })

  it("leaves a read-only document unchanged", () => {
    const { view, cleanup } = mount("hello world", 6, [EditorState.readOnly.of(true)])
    try {
      press(view, "b")
      expect(view.state.doc.toString()).toBe("hello world")
    } finally {
      cleanup()
    }
  })
})
