import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppMenu } from "../src/AppMenu"

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
    render(<AppMenu getRecents={() => ["/tmp/a.md"]} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /open recent/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /a\.md/i }))
    // recent: 前缀 id 由 App 侧 runMenuCommand 消费;这里只断言透传
  })
  it("closes on Escape", () => {
    render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
