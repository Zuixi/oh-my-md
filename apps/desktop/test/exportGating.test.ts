import { fireEvent, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    getPendingOrderedListNormalization: vi.fn(() => null),
  }
})

const { editor } = vi.hoisted(() => ({
  editor: {
    create: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

const MACOS_WKWEBVIEW_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
const WINDOWS_WEBVIEW2_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const LINUX_WEBKIT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"
const DEFAULT_USER_AGENT = window.navigator.userAgent

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
}

afterEach(() => {
  setUserAgent(DEFAULT_USER_AGENT)
  resetMountedApps()
})

describe("export command gating", () => {
  it("keeps PDF and image export commands on macOS", () => {
    setUserAgent(MACOS_WKWEBVIEW_UA)
    const harness = createAppHarness(editor)
    harness.renderApp()

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })

    expect(screen.getByPlaceholderText("Run a command…")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Export Image" })).toBeTruthy()
  })

  it("offers PDF on Windows in both the File menu and the palette", () => {
    setUserAgent(WINDOWS_WEBVIEW2_UA)
    const harness = createAppHarness(editor)
    harness.renderApp()

    fireEvent.click(screen.getByRole("button", { name: "File" }))
    expect(screen.getByRole("menuitem", { name: "Export PDF" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true })

    expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy()
  })

  it("hides PDF on Linux while keeping HTML and PNG export", () => {
    setUserAgent(LINUX_WEBKIT_UA)
    const harness = createAppHarness(editor)
    harness.renderApp()

    fireEvent.click(screen.getByRole("button", { name: "File" }))
    expect(screen.queryByRole("menuitem", { name: "Export PDF" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true })

    expect(screen.getByPlaceholderText("Run a command…")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull()
    expect(screen.getByRole("button", { name: "Export Image" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Export HTML" })).toBeTruthy()
  })
})
