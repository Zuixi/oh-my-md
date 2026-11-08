import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsModal } from "../src/SettingsModal"
import { DEFAULT_SETTINGS } from "../src/settings"
import { initLocale } from "../src/i18n"
import { ISSUES_URL, TROUBLESHOOTING_URL } from "../src/constants"
import type { LogStateView } from "../src/logging"

const off: LogStateView = { degraded: false, dir: "", destination: { kind: "off" } }
const running: LogStateView = { degraded: false, dir: "/logs", destination: { kind: "directory" } }

afterEach(() => initLocale("en"))

function renderPanel(overrides: {
  loggingEnabled?: boolean
  logState?: LogStateView
  openUrl?: (url: string) => void
  onRestartToApplyLogging?: () => void
} = {}) {
  return render(
    <SettingsModal
      isOpen={true}
      settings={{ ...DEFAULT_SETTINGS, loggingEnabled: overrides.loggingEnabled ?? false }}
      onSave={vi.fn()}
      onClose={vi.fn()}
      logState={overrides.logState ?? off}
      openUrl={overrides.openUrl}
      onRestartToApplyLogging={overrides.onRestartToApplyLogging}
    />,
  )
}

// Without these links the feature ends at "logging is on": the guide (where the
// file is, what to send) and the issue form are the only way a user completes
// the support loop from inside the app.
describe("logging panel links out instead of dead-ending", () => {
  it("offers the troubleshooting guide and the issue form", () => {
    const openUrl = vi.fn()
    renderPanel({ openUrl })
    fireEvent.click(screen.getByRole("button", { name: "How to report a problem" }))
    expect(openUrl).toHaveBeenLastCalledWith(TROUBLESHOOTING_URL)
    fireEvent.click(screen.getByRole("button", { name: "Report an issue" }))
    expect(openUrl).toHaveBeenLastCalledWith(ISSUES_URL)
  })

  it("keeps the links reachable from the healthy state too", () => {
    const openUrl = vi.fn()
    renderPanel({ loggingEnabled: true, logState: running, openUrl })
    expect(screen.getByRole("button", { name: "How to report a problem" })).toBeTruthy()
  })
})

// The toggles only apply after a restart, which lands on exactly the person who
// just hit a bug. The panel offers the restart instead of a manual quit/reopen.
describe("restart to apply", () => {
  it("offers a restart while the change is pending", () => {
    const onRestartToApplyLogging = vi.fn()
    renderPanel({ loggingEnabled: true, logState: off, onRestartToApplyLogging })
    fireEvent.click(screen.getByRole("button", { name: "Restart now to apply" }))
    expect(onRestartToApplyLogging).toHaveBeenCalledOnce()
  })

  it("offers it when logging is about to stop as well", () => {
    renderPanel({ loggingEnabled: false, logState: running, onRestartToApplyLogging: vi.fn() })
    expect(screen.getByRole("button", { name: "Restart now to apply" })).toBeTruthy()
  })

  it("hides the restart when nothing is pending", () => {
    renderPanel({ loggingEnabled: true, logState: running, onRestartToApplyLogging: vi.fn() })
    expect(screen.queryByRole("button", { name: "Restart now to apply" })).toBeNull()
  })
})
