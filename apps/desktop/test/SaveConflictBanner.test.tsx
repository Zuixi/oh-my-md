import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SaveConflictBanner } from "../src/SaveConflictBanner"

const baseProps = {
  message: "This file changed on disk.",
  actions: [
    { id: "compare" as const, label: "Compare" },
    { id: "reloadDisk" as const, label: "Reload disk" },
  ],
  busy: false,
  onSelect: vi.fn(),
}

describe("SaveConflictBanner", () => {
  it("announces the conflict and exposes every action in order", () => {
    const onSelect = vi.fn()
    render(
      <SaveConflictBanner
        message="This file changed on disk."
        actions={[
          { id: "compare", label: "Compare" },
          { id: "reloadDisk", label: "Reload disk" },
        ]}
        busy={false}
        focusToken={0}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByRole("status", { name: "Save conflict" }).textContent).toContain(
      "This file changed on disk.",
    )
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.textContent)).toEqual(["Compare", "Reload disk"])
    fireEvent.click(buttons[1])
    expect(onSelect).toHaveBeenCalledWith("reloadDisk")
  })

  it("focuses the first action when the focus token changes", () => {
    const view = render(<SaveConflictBanner {...baseProps} focusToken={0} />)
    view.rerender(<SaveConflictBanner {...baseProps} focusToken={1} />)
    expect(document.activeElement?.textContent).toBe("Compare")
  })
})
