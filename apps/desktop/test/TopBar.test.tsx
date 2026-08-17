import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TopBar } from "../src/TopBar"
import { createFileSession, createSession, type EditorSession } from "../src/session"

const dummyVersion = { resolvedPath: "", fingerprint: "" }

const sampleTabs: EditorSession[] = [
  createFileSession(1, "/notes/alpha.md", "", dummyVersion),
  createFileSession(2, "/notes/beta.md", "", dummyVersion),
  createSession(3),
]

describe("TopBar", () => {
  it("renders tabs and highlights the active tab with topbar-file class", () => {
    render(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )

    const tabs = screen.getAllByRole("button", { name: /alpha\.md|beta\.md|unnamed/ })
    expect(tabs).toHaveLength(3)

    const activeTab = tabs[0]
    expect(activeTab.classList.contains("is-active")).toBe(true)
    expect(activeTab.querySelector(".topbar-file")?.textContent).toBe("alpha.md")
  })

  it("handles tab click, close click, and new tab click", () => {
    const onFocusTab = vi.fn()
    const onCloseTab = vi.fn()
    const onNewTab = vi.fn()

    render(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        onFocusTab={onFocusTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />,
    )

    const tabs = screen.getAllByRole("button", { name: /alpha\.md|beta\.md|unnamed/ })
    fireEvent.click(tabs[1])
    expect(onFocusTab).toHaveBeenCalledWith(2)

    const closeButtons = screen.getAllByLabelText("Close tab")
    expect(closeButtons).toHaveLength(3)
    fireEvent.click(closeButtons[0])
    expect(onCloseTab).toHaveBeenCalledWith(1)
    expect(onFocusTab).toHaveBeenCalledTimes(1) // stopPropagation should prevent onFocusTab

    const newTabButton = screen.getByRole("button", { name: "+" })
    fireEvent.click(newTabButton)
    expect(onNewTab).toHaveBeenCalledOnce()
  })

  it("displays dirty and conflict indicators properly", () => {
    render(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={true}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[1, 2]}
        conflictIds={[2]}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("Unsaved")).toBeTruthy()
    expect(screen.getByLabelText("Conflict")).toBeTruthy()
  })

  it("renders workspace breadcrumb when workspace is provided", () => {
    render(
      <TopBar
        workspace="/users/me/project"
        filePath="/users/me/project/docs/guide.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )

    expect(screen.getByText("project")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
  })

  it("renders sidebar expansion toggle when sidebar is collapsed", () => {
    const onToggleSidebar = vi.fn()
    const { rerender } = render(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        sidebarOpen={false}
        onToggleSidebar={onToggleSidebar}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )

    const toggleBtn = screen.getByRole("button", { name: /show sidebar/i })
    expect(toggleBtn).toBeTruthy()
    fireEvent.click(toggleBtn)
    expect(onToggleSidebar).toHaveBeenCalledOnce()

    rerender(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        sidebarOpen={true}
        onToggleSidebar={onToggleSidebar}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )
    expect(screen.queryByRole("button", { name: /show sidebar/i })).toBeNull()
  })

  it("renders preferences button and triggers onOpenSettings when clicked", () => {
    const onOpenSettings = vi.fn()
    render(
      <TopBar
        workspace="/notes"
        filePath="/notes/alpha.md"
        dirty={false}
        tabs={sampleTabs}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[]}
        onOpenSettings={onOpenSettings}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )

    const settingsBtn = screen.getByRole("button", { name: /preferences/i })
    expect(settingsBtn).toBeTruthy()
    fireEvent.click(settingsBtn)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})
