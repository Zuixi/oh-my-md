import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { pastePlainText } from "../src/pastePlainText"

const originalClipboard = navigator.clipboard

function stubClipboardText(text: string) {
  Object.defineProperty(navigator, "clipboard", {
    value: { readText: vi.fn(async () => text) },
    configurable: true,
  })
}

function removeClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  })
}

function mockView(from: number, to: number) {
  const dispatch = vi.fn()
  const view = {
    get state() {
      return { selection: { main: { from, to } } }
    },
    dispatch,
  } as unknown as EditorView
  return { view, dispatch }
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: originalClipboard,
    configurable: true,
  })
})

describe("pastePlainText", () => {
  it("inserts at the captured selection and moves the caret to the end", async () => {
    stubClipboardText("hello")
    const { view, dispatch } = mockView(2, 4)

    await pastePlainText(view)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 2, to: 4, insert: "hello" },
      selection: { anchor: 7 },
      userEvent: "input.paste",
      scrollIntoView: true,
    })
  })

  it("no-ops when the clipboard has no text", async () => {
    stubClipboardText("")
    const { view, dispatch } = mockView(2, 4)

    await pastePlainText(view)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("no-ops when the Clipboard API is unavailable", async () => {
    removeClipboard()
    const { view, dispatch } = mockView(2, 4)

    await pastePlainText(view)

    expect(dispatch).not.toHaveBeenCalled()
  })
})
