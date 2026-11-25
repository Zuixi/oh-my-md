import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { StatusBar } from "../src/StatusBar"
import { createEditorStatusStore } from "../src/editorStatusStore"

const MACOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0"

function withUserAgent(userAgent: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(window.navigator, "userAgent", original)
  }
}

describe("StatusBar", () => {
  it("renders preferences button and workspace breadcrumb on the left and stats on the right", () => {
    const store = createEditorStatusStore()
    const onOpenSettings = vi.fn()
    const onRevealPath = vi.fn()

    render(
      <StatusBar
        statusStore={store}
        stats={{ words: 42, chars: 210 }}
        normalizationReviewRequired={false}
        saveStatus="idle"
        workspace="/users/me/project"
        filePath="/users/me/project/docs/guide.md"
        onOpenSettings={onOpenSettings}
        onRevealPath={onRevealPath}
      />,
    )

    const settingsBtn = screen.getByRole("button", { name: /preferences/i })
    fireEvent.click(settingsBtn)
    expect(onOpenSettings).toHaveBeenCalledOnce()

    expect(screen.getByText("project")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
    expect(screen.getByText("guide.md")).toBeTruthy()

    const pathBtn = screen.getByTitle("/users/me/project/docs/guide.md")
    fireEvent.click(pathBtn)
    expect(onRevealPath).toHaveBeenCalledWith("/users/me/project/docs/guide.md")
  })

  it("shows platform-appropriate shortcut glyphs in the preferences tooltip", () => {
    const store = createEditorStatusStore()

    withUserAgent(MACOS_UA, () => {
      const { unmount } = render(
        <StatusBar
          statusStore={store}
          stats={null}
          normalizationReviewRequired={false}
          saveStatus="idle"
          onOpenSettings={vi.fn()}
        />,
      )
      expect(screen.getByRole("button", { name: /preferences/i }).getAttribute("title"))
        .toBe("Preferences (⌘,)")
      unmount()
    })

    withUserAgent(WINDOWS_UA, () => {
      render(
        <StatusBar
          statusStore={store}
          stats={null}
          normalizationReviewRequired={false}
          saveStatus="idle"
          onOpenSettings={vi.fn()}
        />,
      )
      expect(screen.getByRole("button", { name: /preferences/i }).getAttribute("title"))
        .toBe("Preferences (Ctrl+,)")
    })
  })
})
