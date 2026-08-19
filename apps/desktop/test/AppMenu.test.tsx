import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppMenu, type AppMenuViewState } from "../src/AppMenu"
import { MACOS_ONLY_COMMANDS, MENU_TO_COMMAND } from "../src/commands"
import { APP_MENU_TREE } from "../src/menuTree"

function withUserAgent(userAgent: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
  try {
    run()
  } finally {
    // userAgent 常定义在原型上(实例无自有描述符):删除自有属性即可回落到原型。
    if (original) Object.defineProperty(window.navigator, "userAgent", original)
    else delete (window.navigator as { userAgent?: string }).userAgent
  }
}

const viewState: AppMenuViewState = {
  source: false,
  sidebar: true,
  outline: false,
  typewriter: false,
  focus: false,
}

function renderMenu(
  onCommand: (id: string) => void = () => {},
  recents: string[] = [],
): ReturnType<typeof render> {
  return render(
    <AppMenu getRecents={() => recents} onCommand={onCommand} viewState={viewState} />,
  )
}

describe("AppMenu", () => {
  it("renders nothing on macOS", () => {
    withUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", () => {
      const { container } = renderMenu()
      expect(container.querySelector(".app-menubar")).toBeNull()
    })
  })

  it("renders one top-level button per menu and opens a single menu at a time", () => {
    renderMenu()
    const topButtons = screen.getAllByRole("button").filter(
      button => button.getAttribute("aria-haspopup") === "menu",
    )
    expect(topButtons.map(button => button.textContent)).toEqual(["File", "Edit", "Format", "View", "Help"])

    fireEvent.click(screen.getByRole("button", { name: "File" }))
    // The File panel contains its own entries only — Format/View entries stay closed.
    expect(screen.getByRole("menuitem", { name: /^save$/i })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: /^bold$/i })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: /check for updates/i })).toBeNull()
    expect(screen.getAllByRole("menu")).toHaveLength(1)
  })

  it("dispatches command ids", () => {
    const onCommand = vi.fn()
    renderMenu(onCommand)
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /^save$/i }))
    expect(onCommand).toHaveBeenCalledWith("save")
  })

  it("dispatches the new edit, quit, and about ids", () => {
    const onCommand = vi.fn()
    renderMenu(onCommand)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /^undo$/i }))
    expect(onCommand).toHaveBeenCalledWith("undo")
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /^quit$/i }))
    expect(onCommand).toHaveBeenCalledWith("quit")
    fireEvent.click(screen.getByRole("button", { name: "Help" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /^about/i }))
    expect(onCommand).toHaveBeenCalledWith("about")
  })

  it("hides macOS-only export entries on windows", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", () => {
      renderMenu()
      fireEvent.click(screen.getByRole("button", { name: "File" }))
      expect(screen.queryByRole("menuitem", { name: /export pdf/i })).toBeNull()
      expect(screen.getByRole("menuitem", { name: /export html/i })).toBeTruthy()
    })
  })

  it("lists recent files via recent: ids", () => {
    const onCommand = vi.fn()
    renderMenu(onCommand, ["/tmp/a.md"])
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /open recent/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /a\.md/i }))
    // recent: 前缀 id 由 App 侧 runMenuCommand 消费;这里断言透传
    expect(onCommand).toHaveBeenCalledWith("recent:/tmp/a.md")
  })

  it("shows check state for view toggle entries", () => {
    render(
      <AppMenu
        getRecents={() => []}
        onCommand={() => {}}
        viewState={{ ...viewState, source: true, sidebar: false, outline: true }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "View" }))
    const checks = screen.getAllByRole("menuitemcheckbox")
    expect(checks.map(item => item.getAttribute("aria-checked"))).toEqual(["true", "false", "true", "false", "false"])
    // Non-toggle view entries stay plain menu items.
    expect(screen.getByRole("menuitem", { name: /toggle theme/i })).toBeTruthy()
  })

  it("switches menus on hover while one is open", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.pointerOver(screen.getByRole("button", { name: "Edit" }))
    expect(screen.getByRole("menuitem", { name: /^undo$/i })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: /^save$/i })).toBeNull()
  })

  it("switches to the next menu on ArrowRight from the top level", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.keyDown(screen.getByRole("button", { name: "File" }), { key: "ArrowRight" })
    expect(screen.getByRole("menuitem", { name: /^undo$/i })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit" }), { key: "ArrowLeft" })
    expect(screen.getByRole("menuitem", { name: /^save$/i })).toBeTruthy()
  })

  it("navigates menu items with arrow keys, wrapping at both ends", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
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

  it("closes on Escape", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("toggles a menu closed by clicking its top-level button again", () => {
    renderMenu()
    const file = screen.getByRole("button", { name: "File" })
    fireEvent.click(file)
    expect(screen.getByRole("menu")).toBeTruthy()
    fireEvent.click(file)
    expect(screen.queryByRole("menu")).toBeNull()
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
})
