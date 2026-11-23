import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CommandPalette } from "../src/CommandPalette"
import type { AppCommand } from "../src/commands"

afterEach(cleanup)

function commands(): AppCommand[] {
  return [
    { id: "alpha", label: "Alpha", run: vi.fn() },
    { id: "beta", label: "Beta", run: vi.fn() },
    { id: "gamma", label: "Gamma", run: vi.fn() },
  ]
}

describe("command palette keyboard", () => {
  it("navigates with arrows and executes the active row", () => {
    const list = commands()
    render(<CommandPalette commands={list} onClose={() => {}} />)
    const input = screen.getByRole("combobox")
    expect(input.getAttribute("aria-activedescendant")).toBe("command-option-0")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe("command-option-1")
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true")

    fireEvent.keyDown(input, { key: "Enter" })
    expect(list[1]?.run).toHaveBeenCalledOnce()
  })

  it("supports Home and End", () => {
    render(<CommandPalette commands={commands()} onClose={() => {}} />)
    const input = screen.getByRole("combobox")
    fireEvent.keyDown(input, { key: "End" })
    expect(input.getAttribute("aria-activedescendant")).toBe("command-option-2")
    fireEvent.keyDown(input, { key: "Home" })
    expect(input.getAttribute("aria-activedescendant")).toBe("command-option-0")
  })

  it("resets the active row when filtering changes the result set", () => {
    render(<CommandPalette commands={commands()} onClose={() => {}} />)
    const input = screen.getByRole("combobox")
    fireEvent.keyDown(input, { key: "End" })
    fireEvent.change(input, { target: { value: "beta" } })
    expect(input.getAttribute("aria-activedescendant")).toBe("command-option-0")
    expect(screen.getAllByRole("option")).toHaveLength(1)
  })

  it("ignores Enter that commits an IME composition", () => {
    const list = commands()
    const onClose = vi.fn()
    render(<CommandPalette commands={list} onClose={onClose} />)
    const input = screen.getByRole("combobox")
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(list[0]?.run).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("keeps option rows out of the tab order", () => {
    render(<CommandPalette commands={commands()} onClose={() => {}} />)
    for (const option of screen.getAllByRole("option")) expect(option.tabIndex).toBe(-1)
  })
})
