import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { unifiedDiff } from "../src/documentDiff"
import { DocumentDiffPanel } from "../src/DocumentDiffPanel"
import { createFileSession } from "../src/session"
import { StatusBar } from "../src/StatusBar"
import { TopBar } from "../src/TopBar"

const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" } as const

describe("DocumentDiffPanel", () => {
  it("renders hunks as text and jumps to the local line", () => {
    const onJump = vi.fn()
    render(
      <DocumentDiffPanel
        hunks={unifiedDiff("a\nmine\n", "a\ntheirs\n")}
        deleted={false}
        refreshed={false}
        onJump={onJump}
        onClose={vi.fn()}
      />,
    )
    const panel = screen.getByRole("region", { name: "Document differences" })
    expect(panel.innerHTML).not.toContain("<script")
    expect(panel.textContent).toContain("theirs")
    fireEvent.click(screen.getByRole("button", { name: "Go to line 2" }))
    expect(onJump).toHaveBeenCalledWith(2)
  })

  it("marks a deleted file and a refreshed snapshot", () => {
    render(
      <DocumentDiffPanel
        hunks={unifiedDiff("mine\n", "")}
        deleted
        refreshed
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("This file was deleted on disk.")).toBeTruthy()
    expect(screen.getByText("Disk contents were refreshed.")).toBeTruthy()
  })
})

describe("TopBar conflict badge", () => {
  it("shows a conflict badge with an accessible name", () => {
    render(
      <TopBar
        workspace={null}
        filePath={null}
        dirty={false}
        tabs={[createFileSession(1, "/notes/a.md", "body", version)]}
        activeId={1}
        dirtyIds={[]}
        conflictIds={[1]}
        onFocusTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    )
    expect(screen.getByLabelText("Conflict")).toBeTruthy()
  })
})

describe("StatusBar save status", () => {
  it("shows the save status as its own node", () => {
    render(
      <StatusBar
        stats={{ words: 0, chars: 0 }}
        cursor="1:1"
        mode="live"
        normalizationReviewRequired={false}
        saveStatus="conflict"
      />,
    )
    expect(screen.getByText("conflict")).toBeTruthy()
  })

  it("shows CJK-aware word and char counts", () => {
    render(
      <StatusBar
        stats={{ words: 4, chars: 4 }}
        cursor="1:1"
        mode="live"
        normalizationReviewRequired={false}
        saveStatus="idle"
      />,
    )
    expect(screen.getByText("4 words · 4 chars")).toBeTruthy()
  })
})
