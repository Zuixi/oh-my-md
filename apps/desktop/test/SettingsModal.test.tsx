import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SettingsModal } from "../src/SettingsModal"
import { DEFAULT_SETTINGS, type UserSettings } from "../src/settings"

describe("SettingsModal", () => {
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
})
