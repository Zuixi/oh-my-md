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
})
