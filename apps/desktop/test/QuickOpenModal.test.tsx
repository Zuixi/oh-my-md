import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QuickOpenModal } from "../src/QuickOpenModal"

afterEach(cleanup)

describe("quick open listbox", () => {
  it("navigates options and chooses the active file", () => {
    const onChoose = vi.fn()
    const onClose = vi.fn()
    render(
      <QuickOpenModal
        files={["/notes/a.md", "/notes/b.md"]}
        folder="/notes"
        truncated={false}
        loading={false}
        onChoose={onChoose}
        onClose={onClose}
      />,
    )
    const input = screen.getByRole("combobox")
    expect(screen.getAllByRole("option")).toHaveLength(2)
    expect(input.getAttribute("aria-activedescendant")).toBe("quick-open-option-0")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe("quick-open-option-1")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChoose).toHaveBeenCalledWith("/notes/b.md")
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("ignores Enter that commits an IME composition", () => {
    const onChoose = vi.fn()
    const onClose = vi.fn()
    render(
      <QuickOpenModal
        files={["/notes/a.md"]}
        folder="/notes"
        truncated={false}
        loading={false}
        onChoose={onChoose}
        onClose={onClose}
      />,
    )
    const input = screen.getByRole("combobox")
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(onChoose).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("keeps option rows out of the tab order", () => {
    render(
      <QuickOpenModal
        files={["/notes/a.md", "/notes/b.md"]}
        folder="/notes"
        truncated={false}
        loading={false}
        onChoose={() => {}}
        onClose={() => {}}
      />,
    )
    for (const option of screen.getAllByRole("option")) expect(option.tabIndex).toBe(-1)
  })
})
