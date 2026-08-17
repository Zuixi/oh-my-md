import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi, afterEach } from "vitest"
import { FindReplaceBar } from "../src/FindReplaceBar"
import { initLocale, setLocale } from "../src/i18n"

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
  afterEach(() => initLocale("en"))

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

  it("renders Chinese placeholders and aria-labels when locale is zh", () => {
    setLocale("zh")
    renderBar({ matchCount: 2, activeIndex: 0 })
    expect(screen.getByPlaceholderText("在文档中查找…")).toBeTruthy()
    expect(screen.getByLabelText("查找")).toBeTruthy()
    expect(screen.getByText("1 / 2")).toBeTruthy()
  })

  it("renders English placeholders and aria-labels when locale is en", () => {
    setLocale("en")
    renderBar({ matchCount: 2, activeIndex: 0 })
    expect(screen.getByPlaceholderText("Find in document…")).toBeTruthy()
    expect(screen.getByLabelText("Find")).toBeTruthy()
    expect(screen.getByText("1 of 2")).toBeTruthy()
  })

  it("renders the zero-match status when there are no matches", () => {
    setLocale("en")
    renderBar({ matchCount: 0, activeIndex: 0 })
    expect(screen.getByText("0 matches")).toBeTruthy()
  })
})
