import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FontFamilyPicker, type FontFamilyPickerProps } from "../src/FontFamilyPicker"
import { cssFamily, FONT_FAMILY_PRESETS } from "../src/settings"
import { initLocale } from "../src/i18n"

function renderPicker(overrides: Partial<FontFamilyPickerProps> = {}) {
  const props: FontFamilyPickerProps = {
    value: FONT_FAMILY_PRESETS[0].value,
    families: ["Arial", "Menlo"],
    loading: false,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<FontFamilyPicker {...props} />) }
}

function openPopover(): void {
  fireEvent.click(screen.getByRole("button", { name: "System Default" }))
}

describe("FontFamilyPicker", () => {
  beforeEach(() => { initLocale("en") })
  afterEach(() => { initLocale("en") })

  it("labels the trigger with the preset, loaded family, or custom fallback", () => {
    const { props, rerender } = renderPicker()
    expect(screen.getByRole("button", { name: "System Default" })).toBeTruthy()

    rerender(<FontFamilyPicker {...props} value={cssFamily("Menlo")} />)
    expect(screen.getByRole("button", { name: "Menlo" })).toBeTruthy()

    rerender(<FontFamilyPicker {...props} value="Comic Sans" />)
    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy()
  })

  it("shows a failure note but keeps presets selectable when families is null", () => {
    const onSelect = vi.fn()
    renderPicker({ families: null, onSelect })
    openPopover()
    expect(screen.getByText("Failed to load system fonts")).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "Serif" }))
    expect(onSelect).toHaveBeenCalledWith(FONT_FAMILY_PRESETS[2].value)
    expect(screen.queryByPlaceholderText("Search fonts…")).toBeNull()
  })

  it("shows a loading state before families resolve", () => {
    renderPicker({ families: [], loading: true })
    openPopover()
    expect(screen.getByText("Loading…")).toBeTruthy()
    expect(screen.getByRole("option", { name: "System Default" })).toBeTruthy()
    expect(screen.queryByText("System fonts")).toBeNull()
  })

  it("caps rendered family rows and notes the truncation", () => {
    const families = Array.from({ length: 250 }, (_, index) => `Family ${index}`)
    renderPicker({ families })
    openPopover()
    expect(screen.getAllByRole("option")).toHaveLength(3 + 200)
    expect(screen.getByText("Showing 200 of 250 fonts")).toBeTruthy()
  })

  it("moves the active row with arrow keys and commits it with Enter", () => {
    const onSelect = vi.fn()
    renderPicker({ onSelect })
    openPopover()
    const search = screen.getByPlaceholderText("Search fonts…")
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith(FONT_FAMILY_PRESETS[1].value)
    expect(screen.queryByPlaceholderText("Search fonts…")).toBeNull()
  })

  it("closes the popover on a press outside", () => {
    renderPicker()
    openPopover()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByPlaceholderText("Search fonts…")).toBeNull()
    expect(screen.getByRole("button", { name: "System Default" })).toBeTruthy()
  })

  it("notifies the host when the popover opens", () => {
    const onOpen = vi.fn()
    renderPicker({ onOpen })
    openPopover()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
