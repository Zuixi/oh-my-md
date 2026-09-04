import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UpdateBanner, type UpdateBannerProps } from "../src/UpdateBanner"
import type { UpdateState } from "../src/updateCoordinator"
import type { UpdateBlockedTab } from "../src/updateRestartReadiness"

const UPDATE = {
  version: "0.1.1",
  notes: "Bug fixes and polish.\n\nA second paragraph.",
  publishedAt: "2026-09-10T10:00:00Z",
} as const

function baseProps(overrides: Partial<UpdateBannerProps> = {}): UpdateBannerProps {
  return {
    state: { kind: "idle" },
    onDownload: vi.fn(),
    onViewRelease: vi.fn(),
    onDismiss: vi.fn(),
    onRequestInstall: vi.fn(),
    onInstall: vi.fn(),
    onFocusBlockedTab: vi.fn(),
    ...overrides,
  }
}

function renderBanner(state: UpdateState, overrides: Partial<UpdateBannerProps> = {}) {
  const props = baseProps({ state, ...overrides })
  render(<UpdateBanner {...props} />)
  return props
}

describe("UpdateBanner", () => {
  it("renders nothing while idle", () => {
    renderBanner({ kind: "idle" })
    expect(document.querySelector(".update-banner")).toBeNull()
  })

  it("shows a checking status", () => {
    renderBanner({ kind: "checking", source: "manual" })
    expect(screen.getByRole("status").textContent).toContain("Checking for updates")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })

  it("renders the available state with version, plain-text notes, and all actions", () => {
    const props = renderBanner({
      kind: "available",
      update: UPDATE,
      installSupported: true,
    })
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("0.1.1")
    expect(status.textContent).toContain("is available")
    expect(screen.getByText(/Bug fixes and polish\./)).toBeTruthy()
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.textContent)).toEqual([
      "Download update",
      "View release",
      "Later",
    ])
    fireEvent.click(buttons[0])
    expect(props.onDownload).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "View release" }))
    expect(props.onViewRelease).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("omits the notes paragraph when the manifest carries none", () => {
    renderBanner({
      kind: "available",
      update: { version: "0.1.1", notes: "" },
      installSupported: true,
    })
    expect(document.querySelector(".update-banner-notes")).toBeNull()
  })

  it("renders plain-text notes without injecting HTML", () => {
    renderBanner({
      kind: "available",
      update: { version: "0.1.1", notes: '<img src="x" onerror="window.__pwned = true">bogus' },
      installSupported: true,
    })
    expect(document.querySelector(".update-banner-notes img")).toBeNull()
    expect(document.querySelector(".update-banner-notes")?.textContent).toContain("<img")
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
    expect(document.querySelector("[dangerouslySetInnerHTML]")).toBeNull()
  })

  it("renders a check-only available state as an Open Release action, never a download", () => {
    const props = renderBanner({
      kind: "available",
      update: UPDATE,
      installSupported: false,
    })
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.textContent)).toEqual(["Open Release", "Later"])
    fireEvent.click(buttons[0])
    expect(props.onDownload).toHaveBeenCalled()
  })

  it("renders downloading with byte progress and percentage when the total is known", () => {
    const props = renderBanner({
      kind: "downloading",
      update: UPDATE,
      downloaded: 512 * 1024,
      total: 1024 * 1024,
    })
    expect(screen.getByRole("status").textContent).toContain("Downloading oh-my-md 0.1.1")
    expect(document.querySelector(".update-banner-progress")?.textContent).toContain("512 KB")
    expect(document.querySelector(".update-banner-progress")?.textContent).toContain("1.0 MB")
    expect(document.querySelector(".update-banner-progress")?.textContent).toContain("50%")
    fireEvent.click(screen.getByRole("button", { name: "Hide" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("renders downloading without a progress row when the total is unknown", () => {
    renderBanner({
      kind: "downloading",
      update: UPDATE,
      downloaded: 7,
    })
    expect(document.querySelector(".update-banner-progress")).toBeNull()
  })

  it("renders downloaded with restart-and-install and Later actions", () => {
    const props = renderBanner({ kind: "downloaded", update: UPDATE })
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("0.1.1")
    expect(status.textContent).toContain("ready to install")
    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))
    expect(props.onRequestInstall).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("lists every blocked document with its display name and reason", () => {
    const reasons: readonly UpdateBlockedTab[] = [
      { tabId: 1, displayName: "draft.md", reason: "dirtyDocument" },
      { tabId: 2, displayName: "notes.md", reason: "pendingNormalization" },
    ]
    const props = renderBanner({
      kind: "blocked",
      update: UPDATE,
      reasons,
    })
    expect(screen.getByRole("status").textContent).toContain("0.1.1")
    const list = document.querySelector(".update-banner-blocked-list")
    expect(list?.textContent).toContain("draft.md")
    expect(list?.textContent).toContain("Unsaved changes")
    expect(list?.textContent).toContain("notes.md")
    expect(list?.textContent).toContain("Ordered-list review pending")
    fireEvent.click(screen.getByRole("button", { name: "View first problem document" }))
    expect(props.onFocusBlockedTab).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("shows the final confirmation before install and wires install to its own action", () => {
    const props = renderBanner({ kind: "readyToInstall", update: UPDATE })
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("close and restart")
    expect(status.textContent).toContain("documents are saved")
    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }))
    expect(props.onInstall).toHaveBeenCalled()
    expect(props.onRequestInstall).not.toHaveBeenCalled()
  })

  it("renders the installing state without claiming it can be cancelled", () => {
    const props = renderBanner({ kind: "installing", update: UPDATE })
    expect(screen.getByRole("status").textContent).toContain("Installing oh-my-md 0.1.1")
    fireEvent.click(screen.getByRole("button", { name: "Hide" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("renders a generic failed message with only a Later action", () => {
    const props = renderBanner({
      kind: "failed",
      stage: "check",
      failure: "network",
      retryable: true,
    })
    expect(screen.getByRole("status").textContent).toContain("Could not reach the update service")
    expect(screen.queryByRole("button", { name: "Open Release" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(props.onDismiss).toHaveBeenCalled()
  })

  it("shows the session-flush timeout message and never an install action", () => {
    renderBanner({
      kind: "failed",
      stage: "readiness",
      failure: "flushTimeout",
      retryable: false,
    })
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("did not finish saving session state")
    expect(screen.queryByRole("button", { name: "Restart and install" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open Release" })).toBeNull()
  })

  it("offers the official Release link for signature and install failures", () => {
    const props = renderBanner({
      kind: "failed",
      stage: "install",
      failure: "install",
      retryable: false,
    })
    fireEvent.click(screen.getByRole("button", { name: "Open Release" }))
    expect(props.onViewRelease).toHaveBeenCalled()
  })
})