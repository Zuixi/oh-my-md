// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockRenderMermaidSvg = vi.fn()

vi.mock("@omd/engine", async () => {
  const actual = await vi.importActual<typeof import("@omd/engine")>("@omd/engine")
  return {
    ...actual,
    renderMermaidSvg: (...args: Parameters<typeof actual.renderMermaidSvg>) => mockRenderMermaidSvg(...args),
  }
})

const { MediaLightbox, useMediaLightbox } = await import("../src/MediaLightbox")

const MERMAID_TARGET = {
  kind: "mermaid" as const,
  source: "graph LR\n  A[Line 1<br>Line 2] --> B[Done]",
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme")
  mockRenderMermaidSvg.mockReset().mockImplementation(async (source: string, opts?: { id?: string; theme?: string }) => ({
    id: opts?.id ?? "omd-lb-1",
    svg: `<svg id="${opts?.id ?? "omd-lb-1"}" data-theme="${opts?.theme ?? "light"}" style="max-width: 600px;" viewBox="0 0 800 300"><foreignObject><div><span>${source}</span><br><hr></div></foreignObject></svg>`,
  }))
})

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

  it("renders a Mermaid diagram with HTML <br>/<hr> foreignObject labels from source and supports zoom, pan, copy, and Escape", async () => {
    const onClose = vi.fn()
    render(<MediaLightbox target={MERMAID_TARGET} onClose={onClose} />)

    const dialog = document.querySelector<HTMLDialogElement>("dialog.media-lightbox")!
    await waitFor(() => {
      const frame = dialog.querySelector<HTMLElement>(".media-lightbox-svg-frame")
      expect(frame?.hidden).toBe(false)
      expect(frame?.querySelector("svg")).toBeTruthy()
    })

    const svg = dialog.querySelector(".media-lightbox-svg-frame svg")!
    expect(svg.id).toMatch(/^omd-lb-/)
    expect(svg.querySelector("foreignObject br")).toBeTruthy()
    expect(dialog.querySelector(".media-lightbox-broken")).toBeNull()
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

    // Copy SVG writes normalized SVG markup (explicit dimensions, no max-width) to clipboard
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

  it("keeps the native modal open across parent re-renders with a fresh onClose", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal")
    const close = vi.spyOn(HTMLDialogElement.prototype, "close")
    try {
      const { rerender } = render(<MediaLightbox target={MERMAID_TARGET} onClose={() => {}} />)
      expect(showModal).toHaveBeenCalledTimes(1)

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

  it("renders the broken state and disables Copy SVG when Mermaid rendering fails", async () => {
    mockRenderMermaidSvg.mockRejectedValueOnce(new Error("syntax error"))
    render(
      <MediaLightbox
        target={{ kind: "mermaid", source: "!!!bad mermaid!!!" }}
        onClose={() => {}}
      />,
    )
    await waitFor(() => {
      const broken = document.querySelector(".media-lightbox-broken")
      expect(broken?.getAttribute("role")).toBe("status")
    })
    const copyBtn = screen.getByLabelText("Copy SVG") as HTMLButtonElement
    expect(copyBtn.disabled).toBe(true)
    expect(document.querySelector<HTMLElement>(".media-lightbox-svg-frame")?.hidden).toBe(true)
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

  it("pans on a two-finger trackpad scroll and keeps Cmd+scroll as a zoom gesture", async () => {
    render(
      <MediaLightbox
        target={{ kind: "image", src: "photo.png", resolvedSrc: "asset://photo.png", alt: "Photo", title: null }}
        onClose={() => {}}
      />,
    )

    const stage = document.querySelector<HTMLElement>(".media-lightbox-stage")!
    const content = document.querySelector<HTMLElement>(".media-lightbox-content")!

    fireEvent.wheel(stage, { deltaX: 0, deltaY: -10, clientX: 0, clientY: 0 })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(screen.getByText("100%")).toBeTruthy()
    expect(content.style.transform).toContain("translate3d(0px, 10px, 0)")

    const cmdScroll = new WheelEvent("wheel", { deltaY: -10, bubbles: true, cancelable: true })
    Object.defineProperty(cmdScroll, "metaKey", { value: true })
    fireEvent(stage, cmdScroll)
    expect(screen.queryByText("100%")).toBeNull()
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

    fireEvent.wheel(stage, { deltaY: -120, clientX: 0, clientY: 0 })
    expect(screen.queryByText("100%")).toBeNull()

    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 150, clientY: 130 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 150, clientY: 130 })
    expect(onClose).not.toHaveBeenCalled()
    expect(content.style.transform).toContain("translate3d(50px, 30px, 0)")

    fireEvent.pointerDown(stage, { button: 0, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 10, clientY: 10 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
