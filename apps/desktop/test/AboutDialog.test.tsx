import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AboutDialog } from "../src/AboutDialog"
import { PROJECT_URL, REPO_SLUG } from "../src/constants"
import type { DesktopServices } from "../src/desktopServices"
import { initLocale } from "../src/i18n"

function makeServices(overrides: Partial<DesktopServices> = {}): DesktopServices {
  return {
    appVersion: async () => "0.1.5",
    appBuildDate: async () => "2026-11-24",
    openExternal: vi.fn(async () => {}),
    ...overrides,
  } as unknown as DesktopServices
}

describe("AboutDialog", () => {
  beforeEach(() => initLocale("en"))

  it("shows the title, icon, version, build date, and project address", async () => {
    const { container } = render(
      <AboutDialog isOpen={true} services={makeServices()} onClose={vi.fn()} />,
    )

    expect(screen.getByRole("dialog", { name: "About oh-my-md" })).toBeTruthy()
    expect(container.querySelector(".about-icon")).toBeTruthy()
    expect(await screen.findByText("Version 0.1.5")).toBeTruthy()
    expect(await screen.findByText("Built 2026-11-24")).toBeTruthy()
    expect(screen.getByRole("button", { name: `github.com/${REPO_SLUG}` })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Close" })).toBe(document.activeElement)
  })

  it("opens the project page through the external opener", () => {
    const openExternal = vi.fn(async () => {})
    render(
      <AboutDialog
        isOpen={true}
        services={makeServices({ openExternal })}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: `github.com/${REPO_SLUG}` }))
    expect(openExternal).toHaveBeenCalledWith(PROJECT_URL)
  })

  it("closes from the footer button", () => {
    const onClose = vi.fn()
    render(<AboutDialog isOpen={true} services={makeServices()} onClose={onClose} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("hides the build line when the command fails", async () => {
    render(
      <AboutDialog
        isOpen={true}
        services={makeServices({ appBuildDate: async () => { throw new Error("no date") } })}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText("Version 0.1.5")).toBeTruthy()
    expect(screen.queryByText(/^Built /)).toBeNull()
  })
})
