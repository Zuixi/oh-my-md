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

  it("disables both actions while busy", () => {
    render(<NormalizationBanner markerCount={1} busy
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.getAllByRole("button").every(button => button.hasAttribute("disabled"))).toBe(true)
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

  it("appears without modal semantics and without stealing focus", () => {
    render(<NormalizationBanner markerCount={1} busy={false}
      onSave={vi.fn()} onKeepOriginal={vi.fn()} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByRole("status").contains(document.activeElement)).toBe(false)
  })
})

describe("StatusBar normalization review", () => {
  it("keeps path and dirty in one text node beside a separate review notice", () => {
    render(<StatusBar path="untitled" dirty words={0} cursor="1:1" mode="live"
      normalizationReviewRequired />)
    const pathNode = screen.getByText("untitled •")
    const pathTexts = Array.from(pathNode.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
    expect(pathTexts).toEqual(["untitled •"])
    const review = screen.getByText("Normalization review required")
    expect(review === pathNode).toBe(false)
    expect(pathNode.contains(review)).toBe(false)
  })

  it("omits the review notice when no review is required", () => {
    render(<StatusBar path="untitled" dirty words={0} cursor="1:1" mode="live" />)
    expect(screen.getByText("untitled •")).toBeTruthy()
    expect(screen.queryByText("Normalization review required")).toBeNull()
  })
})
