// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach } from "vitest"
import { MediaLightbox, useMediaLightbox } from "../src/MediaLightbox"

const MERMAID_TARGET = {
  kind: "mermaid" as const,
  svg: '<svg id="omd-mmd-9" viewBox="0 0 800 300"><rect width="800" height="300"/></svg>',
  source: "graph LR; A-->B",
}

afterEach(() => cleanup())

describe("MediaLightbox", () => {
  it("renders nothing when target is null", () => {
    const { container } = render(<MediaLightbox target={null} onClose={() => {}} />)
    expect(container.querySelector("dialog")).toBeNull()
  })

  it("renders an image with caption, zoom controls, and edit-source action", () => {
    const onClose = vi.fn()
    const editSource = vi.fn()
    render(
      <MediaLightbox
        target={{
          kind: "image",
          src: "hero.png",
          resolvedSrc: "asset://hero.png",
          alt: "Hero banner",
          title: "Architecture overview",
          editSource,
        }}
        onClose={onClose}
      />,
    )

    const dialog = document.querySelector("dialog.media-lightbox")
    expect(dialog).toBeTruthy()
    expect(screen.getByText("Architecture overview")).toBeTruthy()
    const img = document.querySelector<HTMLImageElement>(".media-lightbox-img")!
    expect(img.src).toBe("asset://hero.png")
    expect(img.alt).toBe("Hero banner")
    expect(screen.getByText("100%")).toBeTruthy()

    // Zoom in via button
    fireEvent.click(screen.getByLabelText("Zoom in (+)"))
    expect(screen.getByText("125%")).toBeTruthy()

    // Zoom out back to 100%
    fireEvent.click(screen.getByLabelText("Zoom out (-)"))
    expect(screen.getByText("100%")).toBeTruthy()

    // Edit source closes and calls editSource
    fireEvent.click(screen.getByLabelText("Edit source"))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(editSource).toHaveBeenCalledTimes(1)
  })

  it("renders a Mermaid SVG diagram and supports keyboard zoom, pan, and Escape close", () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        target={{
          kind: "mermaid",
          svg: '<svg id="omd-mmd-9" viewBox="0 0 800 300"><rect width="800" height="300"/></svg>',
          source: "graph LR; A-->B",
        }}
        onClose={onClose}
      />,
    )

    const dialog = document.querySelector<HTMLDialogElement>("dialog.media-lightbox")!
    const svg = dialog.querySelector(".media-lightbox-svg-frame svg")
    expect(svg).toBeTruthy()
    expect(svg!.id).not.toBe("omd-mmd-9")
    expect(screen.queryByLabelText("Edit source")).toBeNull()

    // Keyboard zoom in (+) and reset (1)
    fireEvent.keyDown(dialog, { key: "+" })
    expect(screen.getByText("125%")).toBeTruthy()

    // Keyboard pan with ArrowRight shifts transform x
    fireEvent.keyDown(dialog, { key: "ArrowRight" })
    const content = dialog.querySelector<HTMLElement>(".media-lightbox-content")!
    expect(content.style.transform).toContain("translate3d(-60px, 0px, 0)")

    // Reset to 100% via '1'
    fireEvent.keyDown(dialog, { key: "1" })
    expect(screen.getByText("100%")).toBeTruthy()
    expect(content.style.transform).toContain("translate3d(0px, 0px, 0) scale(1)")

    // Copy SVG writes cleaned SVG markup (explicit dimensions, no max-width) to clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    fireEvent.click(screen.getByLabelText("Copy SVG"))
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied).toContain('width="800"')
    expect(copied).toContain('height="300"')
    expect(copied).not.toContain("max-width")

    // Keydown events inside the dialog must not bubble to global window shortcuts
    const windowKeys: string[] = []
    const onWindowKey = (e: KeyboardEvent) => windowKeys.push(e.key)
    window.addEventListener("keydown", onWindowKey)
    try {
      fireEvent.keyDown(dialog, { key: "Escape" })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeys).toEqual([])
    } finally {
      window.removeEventListener("keydown", onWindowKey)
    }
  })

  it("keeps the native modal open across parent re-renders with a fresh onClose", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal")
    const close = vi.spyOn(HTMLDialogElement.prototype, "close")
    try {
      const { rerender } = render(<MediaLightbox target={MERMAID_TARGET} onClose={() => {}} />)
      expect(showModal).toHaveBeenCalledTimes(1)

      // A fresh inline `onClose` identity on every parent render used to tear the
      // native modal down and rebuild it (losing zoom state, SVG DOM, and focus).
      rerender(<MediaLightbox target={MERMAID_TARGET} onClose={() => {}} />)
      rerender(<MediaLightbox target={MERMAID_TARGET} onClose={() => {}} />)
      expect(showModal).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
      expect(document.querySelector<HTMLDialogElement>("dialog.media-lightbox")!.open).toBe(true)
    } finally {
      showModal.mockRestore()
      close.mockRestore()
    }
  })

  it("moves focus into the dialog and restores it to the opener on close", () => {
    const opener = document.createElement("button")
    opener.textContent = "open lightbox"
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const onClose = vi.fn()
    const View = (props: { open: boolean }) => (
      <MediaLightbox target={props.open ? MERMAID_TARGET : null} onClose={onClose} />
    )

    try {
      const { rerender } = render(<View open />)
      const closeBtn = screen.getByLabelText("Close (Esc)")
      expect(document.activeElement).toBe(closeBtn)

      // Escape closes the native dialog, which reports the close to React.
      fireEvent.keyDown(document.querySelector("dialog.media-lightbox")!, { key: "Escape" })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(opener)

      rerender(<View open={false} />)
      expect(document.querySelector("dialog.media-lightbox")).toBeNull()
      expect(document.activeElement).toBe(opener)
    } finally {
      opener.remove()
    }
  })

  it("renders the broken state instead of injecting malformed Mermaid SVG", () => {
    render(
      <MediaLightbox
        target={{ kind: "mermaid", svg: "<svg><unclosed", source: "graph LR" }}
        onClose={() => {}}
      />,
    )
    const broken = document.querySelector(".media-lightbox-broken")
    expect(broken?.getAttribute("role")).toBe("status")
    expect(document.querySelector(".media-lightbox-svg-frame")).toBeNull()
    expect(document.querySelector("dialog.media-lightbox")!.innerHTML).not.toContain("unclosed")
  })

  it("auto-dismisses when active tab or document identity changes (useMediaLightbox)", () => {
    function Host(props: { tabId: number; docId: number }) {
      const lb = useMediaLightbox(props.tabId, props.docId)
      return (
        <>
          <button
            type="button"
            onClick={() => lb.open({ kind: "image", src: "a.png", resolvedSrc: "a.png", alt: "A", title: null })}
          >
            open
          </button>
          <MediaLightbox target={lb.target} onClose={lb.close} />
        </>
      )
    }
    const { rerender } = render(<Host tabId={1} docId={1} />)
    fireEvent.click(screen.getByText("open"))
    expect(document.querySelector("dialog.media-lightbox")).toBeTruthy()

    rerender(<Host tabId={2} docId={1} />)
    expect(document.querySelector("dialog.media-lightbox")).toBeNull()
  })

  it("supports wheel zoom, pointer-drag pan without closing, and backdrop click to close", () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        target={{
          kind: "image",
          src: "photo.png",
          resolvedSrc: "https://example.com/photo.png",
          alt: "Photo",
          title: null,
        }}
        onClose={onClose}
      />,
    )

    const stage = document.querySelector<HTMLElement>(".media-lightbox-stage")!
    const content = document.querySelector<HTMLElement>(".media-lightbox-content")!

    // Wheel zoom in
    fireEvent.wheel(stage, { deltaY: -120, clientX: 0, clientY: 0 })
    expect(screen.queryByText("100%")).toBeNull()

    // Drag pan (> 4px threshold) must NOT close on pointerup
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 150, clientY: 130 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 150, clientY: 130 })
    expect(onClose).not.toHaveBeenCalled()
    expect(content.style.transform).toContain("translate3d(50px, 30px, 0)")

    // Plain click on empty stage closes the lightbox
    fireEvent.pointerDown(stage, { button: 0, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 10, clientY: 10 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
