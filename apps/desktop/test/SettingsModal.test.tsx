import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsModal } from "../src/SettingsModal"
import { DEFAULT_SETTINGS, FONT_FAMILY_PRESETS, type UserSettings } from "../src/settings"
import { initLocale } from "../src/i18n"

describe("SettingsModal", () => {
  afterEach(() => initLocale("en"))

  it("does not render when closed", () => {
    render(
      <SettingsModal
        isOpen={false}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole("dialog", { name: "Preferences" })).toBeNull()
  })

  it("renders when open with all settings inputs", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy()
    expect(screen.getByLabelText("Theme")).toBeTruthy()
    expect(screen.getByLabelText("Font Size")).toBeTruthy()
    expect(screen.getByLabelText("Line Height")).toBeTruthy()
    expect(screen.getByLabelText("Tab Size")).toBeTruthy()
    expect(screen.getByLabelText("Default Mode")).toBeTruthy()
    expect(screen.getByLabelText("Spellcheck")).toBeTruthy()
  })

  it("calls onSave when changing settings", () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText("Font Size"), { target: { value: "18" } })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 18 }))

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }))
  })

  it("closes when clicking close button or pressing Escape", () => {
    const onClose = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("resets to defaults when clicking Reset", () => {
    const onSave = vi.fn()
    const customSettings: UserSettings = {
      theme: "dark",
      fontSize: 22,
      fontFamily: "Courier",
      lineHeight: 2.0,
      tabSize: 4,
      defaultMode: "source",
      spellcheck: true,
      locale: "auto",
    }

    render(
      <SettingsModal
        isOpen={true}
        settings={customSettings}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }))
    expect(onSave).toHaveBeenCalledWith(DEFAULT_SETTINGS)
  })

  it("calls onSave with the chosen locale when language select changes", () => {
    const onSave = vi.fn()
    const customSettings: UserSettings = {
      theme: "dark",
      fontSize: 22,
      fontFamily: "Courier",
      lineHeight: 2.0,
      tabSize: 4,
      defaultMode: "source",
      spellcheck: true,
      locale: "auto",
    }

    render(
      <SettingsModal
        isOpen={true}
        settings={customSettings}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } })
    expect(onSave).toHaveBeenCalledWith({ ...customSettings, locale: "zh" })
  })

  it("shows the active font preset label on the picker trigger", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // DEFAULT_SETTINGS.fontFamily is the System Default preset value; the row
    // label names the trigger, whose text shows the active preset label.
    const trigger = screen.getByLabelText("Font Family")
    expect(trigger.tagName).toBe("BUTTON")
    expect(trigger.textContent).toBe("System Default")
  })

  it("filters system families by search and saves the chosen family quoted", async () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
        listSystemFonts={vi.fn(async () => ["Arial", "Menlo"])}
      />,
    )

    fireEvent.click(screen.getByLabelText("Font Family"))
    const search = await screen.findByPlaceholderText("Search fonts…")
    await screen.findByRole("option", { name: "Arial" })

    fireEvent.change(search, { target: { value: "men" } })
    expect(screen.queryByRole("option", { name: "Arial" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Menlo" }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontFamily: "'Menlo'" }))
    expect(screen.queryByPlaceholderText("Search fonts…")).toBeNull()
  })

  it("saves the preset value when a pinned preset is clicked", async () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
        listSystemFonts={vi.fn(async () => ["Arial", "Menlo"])}
      />,
    )

    fireEvent.click(screen.getByLabelText("Font Family"))
    await screen.findByRole("option", { name: "Arial" })
    fireEvent.click(screen.getByRole("option", { name: "Serif" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ fontFamily: FONT_FAMILY_PRESETS[2].value }),
    )
  })

  it("shows the failure note but keeps presets when enumeration fails", async () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
        listSystemFonts={vi.fn(async () => null)}
      />,
    )

    fireEvent.click(screen.getByLabelText("Font Family"))
    expect(await screen.findByText("Failed to load system fonts")).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "Monospace" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ fontFamily: FONT_FAMILY_PRESETS[1].value }),
    )
  })

  it("offers presets only when no font service is provided", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText("Font Family"))
    expect(screen.getByRole("option", { name: "Serif" })).toBeTruthy()
    expect(screen.queryByText("Failed to load system fonts")).toBeNull()
    expect(screen.queryByText("System fonts")).toBeNull()
    expect(screen.queryByRole("option", { name: "Arial" })).toBeNull()
  })

  it("closes only the popover when Escape is pressed inside it", async () => {
    const onClose = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={onClose}
        listSystemFonts={vi.fn(async () => ["Arial", "Menlo"])}
      />,
    )

    fireEvent.click(screen.getByLabelText("Font Family"))
    const search = await screen.findByPlaceholderText("Search fonts…")
    fireEvent.keyDown(search, { key: "Escape" })

    expect(screen.queryByPlaceholderText("Search fonts…")).toBeNull()
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
