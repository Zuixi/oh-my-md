import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FindReplaceBar } from "../src/FindReplaceBar"

describe("FindReplaceBar", () => {
  it("calls onQuery when the find input changes", () => {
    const onQuery = vi.fn()
    render(
      <FindReplaceBar
        open
        query=""
        replacement=""
        caseSensitive={false}
        replaceOpen={false}
        matchCount={0}
        activeIndex={0}
        onQuery={onQuery}
        onReplacement={vi.fn()}
        onCaseSensitive={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onReplace={vi.fn()}
        onReplaceAll={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "foo" } })
    expect(onQuery).toHaveBeenCalledWith("foo")
  })
})
