import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsModal } from "../src/SettingsModal"
import { DEFAULT_SETTINGS, FONT_FAMILY_PRESETS, type UserSettings } from "../src/settings"
import { initLocale } from "../src/i18n"
import type { LogStateView } from "../src/logging"

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
    expect(screen.getByLabelText("Export Width")).toBeTruthy()
    expect(screen.getByLabelText("Quality")).toBeTruthy()
    expect(screen.getByLabelText("Enable verbose logging")).toBeTruthy()
  })

  it("saves the verbose-logging toggle", () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={{ ...DEFAULT_SETTINGS, loggingEnabled: true }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText("Enable verbose logging"))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ verboseLogging: true }),
    )
  })

  // The restart note is the honest half of the toggle: `effective_level()` runs
  // once, when the plugin is built during startup, so flipping the checkbox
  // cannot change this session's level.
  it("tells the user the verbose toggle applies after a restart", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByText("Only applies when logging is on. Takes effect after restarting oh-my-md."),
    ).toBeTruthy()
  })

  // The real directory answered the probe: there is nothing to warn about, and
  // a warning here would be noise on every normal launch.
  it("shows no logging warning when logging writes to the real directory", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
        logState={{ degraded: false, dir: "/Users/me/Library/Logs/oh-my-md", destination: { kind: "directory" } }}
      />,
    )
    expect(screen.queryByText("Logging is degraded")).toBeNull()
  })

  // Fallback: records really do land in the temp directory, so the copy names
  // it — and says why, since the fix is usually filesystem permissions on the
  // real log directory.
  it("names the temp directory when logging degraded to the fallback", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
        logState={{ degraded: true, dir: "/tmp", destination: { kind: "fallback" } }}
      />,
    )
    expect(screen.getByText("Logging is degraded")).toBeTruthy()
    expect(
      screen.getByText("The log folder was not writable; logs are going to:"),
    ).toBeTruthy()
    expect(screen.getByText("/tmp")).toBeTruthy()
  })

  // Both registrations failed, so there is no file and — because the `Stdout`
  // target lives inside the same plugin dispatch — no console stream either.
  // Promising a directory here would send the user to a path nothing writes, so
  // the warning must say so and must not print a path at all.
  it("warns that nothing is being logged when file logging is disabled", () => {
    const { container } = render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
        logState={{ degraded: true, dir: "", destination: { kind: "disabled" } }}
      />,
    )
    expect(screen.getByText("Logging is degraded")).toBeTruthy()
    expect(
      screen.getByText(
        "No log file could be opened, so this session is not being logged.",
      ),
    ).toBeTruthy()
    expect(container.querySelector(".settings-warning-path")).toBeNull()
  })

  it("renders the three auto pair checkboxes checked by default", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const contractIds: Array<[string, string]> = [
      ["Auto pair brackets", "setting-auto-pair-brackets"],
      ["Auto pair quotes", "setting-auto-pair-quotes"],
      ["Auto pair Markdown syntax", "setting-auto-pair-markdown"],
    ]
    for (const [label, id] of contractIds) {
      const checkbox = screen.getByLabelText(label) as HTMLInputElement
      expect(checkbox.id).toBe(id)
      expect(checkbox.checked).toBe(true)
    }
  })

  it("saves a cleared auto pair toggle without disturbing the other two", () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText("Auto pair quotes"))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      autoPair: { brackets: true, quotes: false, markdownSyntax: true },
    }))
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
      autoPair: { brackets: true, quotes: true, markdownSyntax: true },
      locale: "auto",
      exportWidth: 1200,
      exportScale: 3,
      loggingEnabled: true,
      loggingGeneration: 0,
      verboseLogging: false,
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
      autoPair: { brackets: true, quotes: true, markdownSyntax: true },
      locale: "auto",
      exportWidth: 1200,
      exportScale: 3,
      loggingEnabled: true,
      loggingGeneration: 0,
      verboseLogging: false,
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

// PNG export size: width × scale is the exported bitmap's pixel width. Both
// selects drive the same draft-save path as every other row, so each change
// commits through onSave immediately.
describe("export settings", () => {
  it("shows the current export width and scale", () => {
    render(
      <SettingsModal
        isOpen={true}
        settings={{ ...DEFAULT_SETTINGS, exportWidth: 1200, exportScale: 3 }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByLabelText("Export Width")).toHaveProperty("value", "1200")
    expect(screen.getByLabelText("Quality")).toHaveProperty("value", "3")
    expect(screen.getByText("Resulting image width: 3600 px")).toBeTruthy()
  })

  it("saves width and scale changes and updates the pixel width", () => {
    const onSave = vi.fn()
    function ExportHarness() {
      const [settings, setSettings] = useState(DEFAULT_SETTINGS)
      return (
        <SettingsModal
          isOpen={true}
          settings={settings}
          onSave={next => {
            onSave(next)
            setSettings(next)
          }}
          onClose={vi.fn()}
        />
      )
    }
    render(<ExportHarness />)

    const widthSelect = screen.getByLabelText("Export Width")
    const scaleSelect = screen.getByLabelText("Quality")
    expect(widthSelect).toHaveProperty("value", "800")
    expect(scaleSelect).toHaveProperty("value", "2")
    expect(screen.getByText("Resulting image width: 1600 px")).toBeTruthy()

    fireEvent.change(widthSelect, { target: { value: "1920" } })
    fireEvent.change(scaleSelect, { target: { value: "3" } })

    expect(screen.getByText("Resulting image width: 5760 px")).toBeTruthy()
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ exportWidth: 1920, exportScale: 3 }),
    )
  })
})

// Logging is opt-in, and the default install must say so plainly. The "off"
// state is the user's own choice, so it must not borrow the degraded wording —
// nothing failed, and telling a user their logging is "degraded" before they
// ever enabled it is a false alarm on every fresh install.
describe("logging opt-in", () => {
  const renderWithSettings = (settings: UserSettings, logState?: LogStateView) => render(
    <SettingsModal
      isOpen={true}
      settings={settings}
      onSave={vi.fn()}
      onClose={vi.fn()}
      logState={logState}
    />,
  )

  it("is off by default and explains how to turn it on", () => {
    renderWithSettings(DEFAULT_SETTINGS, { degraded: false, dir: "", destination: { kind: "off" } })
    expect(screen.getByLabelText("Save diagnostic logs")).toHaveProperty("checked", false)
    expect(screen.getByText("Logging is off")).toBeTruthy()
    expect(screen.getByText(/Turn on "Save diagnostic logs" and restart/)).toBeTruthy()
    expect(screen.queryByText("Logging is degraded")).toBeNull()
  })

  it("saves the logging toggle", () => {
    const onSave = vi.fn()
    render(
      <SettingsModal
        isOpen={true}
        settings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
        logState={{ degraded: false, dir: "", destination: { kind: "off" } }}
      />,
    )
    fireEvent.click(screen.getByLabelText("Save diagnostic logs"))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ loggingEnabled: true }))
  })

  it("disables the verbose opt-in while logging itself is off", () => {
    renderWithSettings(DEFAULT_SETTINGS, { degraded: false, dir: "", destination: { kind: "off" } })
    expect(screen.getByLabelText("Enable verbose logging")).toHaveProperty("disabled", true)
  })

  it("enables the verbose opt-in once logging is on", () => {
    renderWithSettings(
      { ...DEFAULT_SETTINGS, loggingEnabled: true },
      { degraded: false, dir: "/logs", destination: { kind: "directory" } },
    )
    expect(screen.getByLabelText("Enable verbose logging")).toHaveProperty("disabled", false)
  })
})

// The checkbox and the engine disagree for exactly one session, because
// `install()` runs at startup. Reporting only the engine's answer told a user
// who had just enabled logging to "turn on Save diagnostic logs" — an
// instruction that contradicts the control directly above it.
describe("logging status follows the pending change", () => {
  const off: LogStateView = { degraded: false, dir: "", destination: { kind: "off" } }
  const running: LogStateView = { degraded: false, dir: "/logs", destination: { kind: "directory" } }

  const renderStatus = (loggingEnabled: boolean, logState: LogStateView) => render(
    <SettingsModal
      isOpen={true}
      settings={{ ...DEFAULT_SETTINGS, loggingEnabled }}
      onSave={vi.fn()}
      onClose={vi.fn()}
      logState={logState}
    />,
  )

  it("says logging starts after a restart when it was just enabled", () => {
    renderStatus(true, off)
    expect(screen.getByText("Logging starts after a restart")).toBeTruthy()
    expect(screen.getByText("This session is not being logged yet. Restart oh-my-md to start.")).toBeTruthy()
    expect(screen.queryByText(/Turn on "Save diagnostic logs"/)).toBeNull()
  })

  it("explains an off level override without offering an endless restart", () => {
    renderStatus(true, { degraded: false, dir: "", destination: { kind: "levelOff" } })
    expect(screen.getByText("Logging is disabled by OMD_LOG=off")).toBeTruthy()
    expect(screen.queryByText("Restart now to apply logging change")).toBeNull()
  })

  it("says logging stops after a restart when it was just disabled", () => {
    renderStatus(false, running)
    expect(screen.getByText("Logging stops after a restart")).toBeTruthy()
    expect(screen.getByText("This session is still writing logs. Restart oh-my-md to stop.")).toBeTruthy()
  })

  it("stays quiet when the checkbox and the engine agree that logging runs", () => {
    renderStatus(true, running)
    expect(screen.queryByText("Logging is off")).toBeNull()
    expect(screen.queryByText("Logging is degraded")).toBeNull()
    expect(screen.queryByText("Logging starts after a restart")).toBeNull()
  })

  it("keeps the degradation warning even after the user disables logging", () => {
    renderStatus(false, { degraded: true, dir: "/tmp", destination: { kind: "fallback" } })
    expect(screen.getByText("Logging is degraded")).toBeTruthy()
  })
})
