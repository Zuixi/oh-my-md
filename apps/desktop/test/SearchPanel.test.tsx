import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SearchPanel, type SearchHit } from "../src/SearchPanel"

function hit(path: string, line: number, text: string, start: number, end: number): SearchHit {
  return { path, line, text, start, end }
}

describe("SearchPanel", () => {
  it("renders grouped collapsible results, summary count, and opens clicked hits", () => {
    const onOpen = vi.fn()
    const first = hit("/notes/docs/guide.md", 12, "hello world", 0, 5)
    const second = hit("/notes/docs/guide.md", 30, "hello again", 0, 5)
    const third = hit("/notes/readme.md", 4, "say hello", 4, 9)

    render(
      <SearchPanel
        folder="/notes"
        query="hello"
        hits={[first, second, third]}
        truncated={false}
        searching={false}
        caseSensitive={false}
        onQuery={vi.fn()}
        onCaseSensitive={vi.fn()}
        onOpen={onOpen}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText("3 results in 2 files")).toBeTruthy()
    const guideHeader = screen.getByRole("button", { name: /guide\.md/i })
    expect(guideHeader.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelectorAll(".search-hit")).toHaveLength(3)

    fireEvent.click(screen.getByText("12").closest("button")!)
    expect(onOpen).toHaveBeenCalledWith(first)

    // Collapsing the group hides its hit rows.
    fireEvent.click(guideHeader)
    expect(guideHeader.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelectorAll(".search-hit")).toHaveLength(1)
  })

  it("toggles case sensitivity with aria-pressed and handles Escape clear-then-close", () => {
    const onQuery = vi.fn()
    const onCaseSensitive = vi.fn()
    const onClose = vi.fn()

    const { rerender } = render(
      <SearchPanel
        folder="/notes"
        query="abc"
        hits={[]}
        truncated={false}
        searching={false}
        caseSensitive={false}
        onQuery={onQuery}
        onCaseSensitive={onCaseSensitive}
        onOpen={vi.fn()}
        onClose={onClose}
      />,
    )

    const caseBtn = screen.getByRole("button", { name: "Match Case" })
    expect(caseBtn.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(caseBtn)
    expect(onCaseSensitive).toHaveBeenCalledWith(true)

    // First Escape clears a non-empty query instead of closing the panel.
    const input = screen.getByRole("textbox", { name: "Find in folder…" })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onQuery).toHaveBeenCalledWith("")
    expect(onClose).not.toHaveBeenCalled()

    // Second Escape (when query is empty) closes the panel.
    rerender(
      <SearchPanel
        folder="/notes"
        query=""
        hits={[]}
        truncated={false}
        searching={false}
        caseSensitive={true}
        onQuery={onQuery}
        onCaseSensitive={onCaseSensitive}
        onOpen={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in folder…" }), { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("shows searching, no-results, truncated, and no-folder states", () => {
    const onOpenFolder = vi.fn()
    const { rerender } = render(
      <SearchPanel
        folder={null}
        query=""
        hits={[]}
        truncated={false}
        searching={false}
        caseSensitive={false}
        onQuery={vi.fn()}
        onCaseSensitive={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onOpenFolder={onOpenFolder}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Open Folder" }))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)

    rerender(
      <SearchPanel
        folder="/notes"
        query="needle"
        hits={[]}
        truncated={false}
        searching={true}
        caseSensitive={false}
        onQuery={vi.fn()}
        onCaseSensitive={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole("status").textContent).toBe("Searching…")

    rerender(
      <SearchPanel
        folder="/notes"
        query="needle"
        hits={[]}
        truncated={true}
        searching={false}
        caseSensitive={false}
        onQuery={vi.fn()}
        onCaseSensitive={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("No matches found")).toBeTruthy()
    expect(screen.getByText(/Results limited to/)).toBeTruthy()
  })
})
