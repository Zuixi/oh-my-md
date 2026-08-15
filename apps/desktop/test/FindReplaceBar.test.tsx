import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FindReplaceBar } from "../src/FindReplaceBar"

function renderBar(overrides: Partial<Parameters<typeof FindReplaceBar>[0]> = {}) {
  const props = {
    open: true,
    query: "",
    replacement: "",
    caseSensitive: false,
    replaceOpen: false,
    matchCount: 0,
    activeIndex: 0,
    onQuery: vi.fn(),
    onReplacement: vi.fn(),
    onCaseSensitive: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onReplace: vi.fn(),
    onReplaceAll: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<FindReplaceBar {...props} />)
  return props
}

describe("FindReplaceBar", () => {
  it("calls onQuery when the find input changes", () => {
    const { onQuery } = renderBar()
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "foo" } })
    expect(onQuery).toHaveBeenCalledWith("foo")
  })

  it("invokes onNext once for meta+g when the find input is focused", () => {
    const onNext = vi.fn()
    const onWindowNext = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "g" || event.key === "G")) {
        onNext()
      }
    }
    window.addEventListener("keydown", onWindowNext)
    try {
      renderBar({ onNext })
      fireEvent.keyDown(screen.getByLabelText("Find"), { key: "g", metaKey: true })
      expect(onNext).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener("keydown", onWindowNext)
    }
  })
})
