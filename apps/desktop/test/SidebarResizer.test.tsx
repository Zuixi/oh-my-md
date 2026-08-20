import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from "../src/constants"
import { SidebarResizer } from "../src/SidebarResizer"

const VIEWPORT_MAX = Math.floor(window.innerWidth * 0.6)

function renderSash(width = SIDEBAR_DEFAULT_WIDTH) {
  const onResize = vi.fn()
  const onCommit = vi.fn()
  const onReset = vi.fn()
  const { container } = render(
    <SidebarResizer width={width} onResize={onResize} onCommit={onCommit} onReset={onReset} />,
  )
  const sash = container.querySelector<HTMLElement>(".sidebar-resizer")
  if (!sash) throw new Error("sash is not mounted")
  return { sash, onResize, onCommit, onReset }
}

describe("SidebarResizer", () => {
  it("resizes by the pointer delta while dragging and commits on release", () => {
    const { sash, onResize, onCommit } = renderSash(230)

    fireEvent.pointerDown(sash, { pointerId: 7, clientX: 230 })
    expect(document.body.classList.contains("omd-resizing-sidebar")).toBe(true)

    fireEvent.pointerMove(sash, { pointerId: 7, clientX: 300 })
    expect(onResize).toHaveBeenLastCalledWith(300)

    fireEvent.pointerMove(sash, { pointerId: 7, clientX: -500 })
    expect(onResize).toHaveBeenLastCalledWith(SIDEBAR_MIN_WIDTH)

    fireEvent.pointerUp(sash, { pointerId: 7, clientX: -500 })
    expect(onCommit).toHaveBeenLastCalledWith(SIDEBAR_MIN_WIDTH)
    expect(document.body.classList.contains("omd-resizing-sidebar")).toBe(false)
  })

  it("clamps drag widths to 60% of the window", () => {
    const { sash, onResize } = renderSash(230)
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 230 })
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 5000 })
    expect(onResize).toHaveBeenLastCalledWith(VIEWPORT_MAX)
    fireEvent.pointerUp(sash, { pointerId: 1, clientX: 5000 })
  })

  it("ignores moves from other pointers", () => {
    const { sash, onResize } = renderSash(230)
    fireEvent.pointerDown(sash, { pointerId: 7, clientX: 230 })
    fireEvent.pointerMove(sash, { pointerId: 9, clientX: 800 })
    expect(onResize).not.toHaveBeenCalled()
    fireEvent.pointerUp(sash, { pointerId: 7, clientX: 230 })
  })

  it("resets to the default width on double-click", () => {
    const { sash, onReset } = renderSash(400)
    fireEvent.doubleClick(sash)
    expect(onReset).toHaveBeenCalledOnce()
  })

  it("adjusts by keyboard steps", () => {
    const { sash, onResize, onCommit } = renderSash(230)
    fireEvent.keyDown(sash, { key: "ArrowRight" })
    expect(onResize).toHaveBeenLastCalledWith(240)
    expect(onCommit).toHaveBeenLastCalledWith(240)
    // The width prop stays 230 in this test (no parent feedback), so each
    // keypress is one step away from 230, not from the previous keystroke.
    fireEvent.keyDown(sash, { key: "ArrowLeft" })
    expect(onResize).toHaveBeenLastCalledWith(220)
  })

  it("exposes separator semantics", () => {
    const { sash } = renderSash(230)
    expect(sash.getAttribute("role")).toBe("separator")
    expect(sash.getAttribute("aria-orientation")).toBe("vertical")
    expect(sash.getAttribute("aria-label")).toBeTruthy()
  })
})
