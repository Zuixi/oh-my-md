import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppMenu } from "../src/AppMenu"
import { MACOS_ONLY_COMMANDS, MENU_TO_COMMAND } from "../src/commands"
import { APP_MENU_TREE } from "../src/menuTree"

function withUserAgent(userAgent: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(window.navigator, "userAgent", original)
  }
}

describe("AppMenu", () => {
  it("renders sections and dispatches command ids", () => {
    const onCommand = vi.fn()
    render(<AppMenu getRecents={() => []} onCommand={onCommand} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    const item = screen.getByRole("menuitem", { name: /^save$/i })
    fireEvent.click(item)
    expect(onCommand).toHaveBeenCalledWith("save")
  })
  it("hides macOS-only export entries on windows", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", () => {
      render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
      fireEvent.click(screen.getByRole("button", { name: /menu/i }))
      expect(screen.queryByRole("menuitem", { name: /export pdf/i })).toBeNull()
      expect(screen.getByRole("menuitem", { name: /export html/i })).toBeTruthy()
    })
  })
  it("lists recent files via recent: ids", () => {
    const onCommand = vi.fn()
    render(<AppMenu getRecents={() => ["/tmp/a.md"]} onCommand={onCommand} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /open recent/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /a\.md/i }))
    // recent: 前缀 id 由 App 侧 runMenuCommand 消费;这里断言透传
    expect(onCommand).toHaveBeenCalledWith("recent:/tmp/a.md")
  })
  it("navigates menu items with arrow keys, wrapping at both ends", () => {
    render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    const panel = screen.getByRole("menu")
    const items = () => screen.getAllByRole("menuitem")

    fireEvent.keyDown(panel, { key: "ArrowDown" })
    expect(document.activeElement).toBe(items()[0])
    fireEvent.keyDown(panel, { key: "ArrowDown" })
    expect(document.activeElement).toBe(items()[1])
    fireEvent.keyDown(panel, { key: "ArrowUp" })
    expect(document.activeElement).toBe(items()[0])
    // Wrap-around at both ends.
    fireEvent.keyDown(panel, { key: "ArrowUp" })
    expect(document.activeElement).toBe(items()[items().length - 1])
    fireEvent.keyDown(panel, { key: "ArrowDown" })
    expect(document.activeElement).toBe(items()[0])
  })
  it("keeps macOSOnly entry flags aligned with MACOS_ONLY_COMMANDS", () => {
    for (const section of APP_MENU_TREE) {
      for (const entry of section.entries) {
        if (entry.macOSOnly === true) {
          expect(MACOS_ONLY_COMMANDS.has(MENU_TO_COMMAND[entry.id] ?? entry.id)).toBe(true)
        }
      }
    }
  })
  it("closes on Escape", () => {
    render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
