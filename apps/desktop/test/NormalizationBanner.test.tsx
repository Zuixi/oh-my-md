import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { NormalizationBanner } from "../src/NormalizationBanner"
import { StatusBar } from "../src/StatusBar"

describe("NormalizationBanner", () => {
  it("announces count and exposes both actions", () => {
    render(<NormalizationBanner markerCount={2} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.getByRole("status").textContent).toContain("2")
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Keep original numbers" })).toBeTruthy()
  })

  it("states that ordered list numbers were normalized", () => {
    render(<NormalizationBanner markerCount={2} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.getByRole("status").textContent).toBe(
      "Ordered list numbers were normalized. 2 items were renumbered.",
    )
  })

  it("keeps the action names out of the announced region", () => {
    render(<NormalizationBanner markerCount={2} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    const status = screen.getByRole("status")
    for (const button of screen.getAllByRole("button")) {
      expect(status.contains(button)).toBe(false)
    }
  })

  it("disables both actions while busy without dropping their focus", () => {
    const onSave = vi.fn()
    const onKeepOriginal = vi.fn()
    render(<NormalizationBanner markerCount={1} busy
      onSave={onSave} onKeepOriginal={onKeepOriginal} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.getAttribute("aria-disabled"))).toEqual([
      "true",
      "true",
    ])
    for (const button of buttons) {
      button.focus()
      expect(document.activeElement).toBe(button)
      fireEvent.click(button)
    }
    expect(onSave).not.toHaveBeenCalled()
    expect(onKeepOriginal).not.toHaveBeenCalled()
  })

  it("runs both named actions in document order", () => {
    const onSave = vi.fn()
    const onKeepOriginal = vi.fn()
    render(<NormalizationBanner markerCount={2} busy={false}
      onSave={onSave} onKeepOriginal={onKeepOriginal} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.textContent)).toEqual([
      "Save normalization",
      "Keep original numbers",
    ])
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    expect(onSave).toHaveBeenCalledOnce()
    expect(onKeepOriginal).toHaveBeenCalledOnce()
  })

  it("keeps an empty live region mounted while no review is pending", () => {
    render(<NormalizationBanner markerCount={null} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.getByRole("status").textContent).toBe("")
    expect(screen.queryAllByRole("button")).toEqual([])
  })

  it("appears without modal semantics and without stealing focus", () => {
    render(<NormalizationBanner markerCount={1} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByRole("status").contains(document.activeElement)).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})

describe("StatusBar normalization review", () => {
  it("shows the review notice as its own text node", () => {
    render(<StatusBar stats={{ words: 0, chars: 0 }} cursor="1:1" mode="live"
      normalizationReviewRequired saveStatus="idle" />)
    const review = screen.getByText("Normalization review required")
    expect(review.textContent).toBe("Normalization review required")
  })

  it("omits the review notice when no review is required", () => {
    render(<StatusBar stats={{ words: 0, chars: 0 }} cursor="1:1" mode="live"
      normalizationReviewRequired={false} saveStatus="idle" />)
    expect(screen.queryByText("Normalization review required")).toBeNull()
  })
})
