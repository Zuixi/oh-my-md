import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import katex from "katex"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"
import { MathBlockWidget, InlineMathWidget } from "../src/decorations/widgets/math"
import { ImageWidget } from "../src/decorations/widgets/image"

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

async function until(predicate: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await tick()
  }
  throw new Error("condition not met in time")
}

// A detached widget gets no real layout: `requestMeasure` is the only view member the
// happy path touches (the block render budget resolves to "unlimited" without state).
const detachedView = () => ({ requestMeasure() {} }) as unknown as EditorView

const bodyOf = (dom: HTMLElement) => dom.querySelector<HTMLElement>(".omd-block-body")!

/**
 * KaTeX is one lazy module per module graph and the cache/singleton live in module state:
 * warm them through the async path so every sync-projection assertion below is
 * deterministic instead of depending on test declaration order.
 */
async function warmKatex() {
  const dom = new MathBlockWidget("$$\nwarmup\n$$", 0).toDOM(detachedView())
  await until(() => bodyOf(dom).dataset.omdRender === "katex")
  dom.remove()
}

describe("math widget sync projection", () => {
  it("commits KaTeX HTML during toDOM once the module is warm (no placeholder flash)", async () => {
    await warmKatex()
    const dom = new MathBlockWidget("$$\nx^2\n$$", 0).toDOM(detachedView())
    const body = bodyOf(dom)
    // No await between toDOM and these assertions: the markup must already be there.
    expect(body.dataset.omdRender).toBe("katex")
    expect(body.querySelector(".katex")).toBeTruthy()
    expect(body.querySelector("pre.omd-block-placeholder")).toBeNull()
    dom.remove()
  })

  it("serves repeated tex from the bounded cache instead of re-rendering", async () => {
    await warmKatex()
    const render = vi.spyOn(katex, "renderToString")
    try {
      const first = new MathBlockWidget("$$\ncached^2\n$$", 0).toDOM(detachedView())
      expect(render).toHaveBeenCalledTimes(1)
      const second = new MathBlockWidget("$$\ncached^2\n$$", 0).toDOM(detachedView())
      // A hit in mathHtmlCache short-circuits KaTeX (display and inline keys never collide).
      expect(render).toHaveBeenCalledTimes(1)
      expect(bodyOf(second).querySelector(".katex")).toBeTruthy()
      first.remove()
      second.remove()
    } finally {
      render.mockRestore()
    }
  })

  it("keeps the source placeholder and reports invalid TeX through the error fallback", async () => {
    await warmKatex()
    const src = "$$\\notacommand{$$"
    const dom = new MathBlockWidget(src, 0).toDOM(detachedView())
    const body = bodyOf(dom)
    // A throwing render is never cached: the synchronous attempt falls back to the <pre>.
    expect(body.dataset.omdRender).toBe("placeholder")
    expect(body.querySelector("pre.omd-block-placeholder")?.textContent).toBe(src)

    await until(() => body.classList.contains("omd-block-error"))
    expect(body.dataset.omdRender).toBe("error")
    expect(body.textContent).toContain("\\notacommand")
    expect(body.textContent).toContain(src)              // raw source survives the failure
    expect(body.querySelector("svg.omd-icon")).toBeTruthy()   // triangle-alert icon
    dom.remove()
  })

  it("projects inline math synchronously and degrades invalid tex to $tex$", async () => {
    await warmKatex()
    const ok = new InlineMathWidget("a^2").toDOM(detachedView())
    expect(ok.querySelector(".katex")).toBeTruthy()

    const bad = new InlineMathWidget("\\notacommand{").toDOM(detachedView())
    expect(bad.textContent).toBe("$\\notacommand{$")
    expect(bad.querySelector(".katex")).toBeNull()
  })
})

// —— popup ResizeObserver ownership ——

type PopupHost = HTMLElement & { __omdMathResizeObs?: ResizeObserver }

const DOC = "$$\nx+y\n$$\n\ntail"

function mountLive(doc: string = DOC) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },   // caret outside the block → block is rendered
      extensions: [editorExtensions()],
    }),
    parent,
  })
  return { view, parent }
}

function openPopup(view: EditorView): PopupHost {
  const block = view.dom.querySelector(".omd-math") as HTMLElement
  block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
  const popup = view.dom.querySelector<PopupHost>(".omd-math-popup")
  expect(popup).toBeTruthy()
  return popup!
}

function mathWidgetOf(view: EditorView) {
  return view.state.field(livePreviewField).specs
    .find(spec => spec.tag === "widget:block:math")?.deco.spec.widget as MathBlockWidget | undefined
}

describe("math popup ResizeObserver lifecycle", () => {
  it("stores the observer on the popup DOM, never on the widget instance", () => {
    const { view, parent } = mountLive()
    const popup = openPopup(view)
    expect(typeof popup.__omdMathResizeObs?.disconnect).toBe("function")
    // The leak came from a widget field retaining the view after a pass-1 DOM swap.
    expect("resizeObs" in (mathWidgetOf(view) as object)).toBe(false)
    view.destroy()
    parent.remove()
  })

  it("disconnects and forgets the observer when the popup closes", () => {
    const { view, parent } = mountLive()
    const popup = openPopup(view)
    const disconnect = vi.spyOn(popup.__omdMathResizeObs!, "disconnect")
    const content = view.dom.querySelector(".omd-math-popup .cm-content") as HTMLElement
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(popup.__omdMathResizeObs).toBeUndefined()
    expect(view.dom.querySelector(".omd-math-popup")).toBeNull()
    view.destroy()
    parent.remove()
  })

  it("releases the observer when CodeMirror discards the widget DOM", async () => {
    const { view, parent } = mountLive()
    const popup = openPopup(view)
    const disconnect = vi.spyOn(popup.__omdMathResizeObs!, "disconnect")
    view.dispatch({ selection: { anchor: 2 } })   // caret enters the block → widget unloads
    await until(() => disconnect.mock.calls.length > 0)

    expect(popup.__omdMathResizeObs).toBeUndefined()
    expect(popup.isConnected).toBe(false)
    view.destroy()
    parent.remove()
  })

  it("still opens the popup where ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    try {
      const { view, parent } = mountLive()
      const popup = openPopup(view)
      expect(popup.__omdMathResizeObs).toBeUndefined()
      expect(popup.querySelector(".omd-math-editor")).toBeTruthy()
      view.destroy()
      parent.remove()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// —— image decode / height-map feedback ——

describe("ImageWidget measure feedback", () => {
  const fakeView = (requestMeasure: () => void) => ({
    state: { facet: () => (src: string) => `broken:${src}` },
    requestMeasure,
  }) as unknown as EditorView

  it("decodes asynchronously and re-measures only for connected images", () => {
    let measures = 0
    const img = new ImageWidget("a.png", "alt", "/a.png")
      .toDOM(fakeView(() => { measures++ })) as HTMLImageElement
    expect(img.decoding).toBe("async")

    // Detached nodes must not poke a layout they are not part of.
    ;(img.onload as ((e: Event) => void) | null)?.(new Event("load"))
    expect(measures).toBe(0)

    document.body.appendChild(img)
    ;(img.onload as ((e: Event) => void) | null)?.(new Event("load"))
    expect(measures).toBe(1)
    img.remove()
  })

  it("replaces a broken image and re-measures at the swap site", () => {
    let measures = 0
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const img = new ImageWidget("missing.png", "alt", "/missing.png")
      .toDOM(fakeView(() => { measures++ })) as HTMLImageElement

    // Detached error: replaced without a measure request (happy-dom throws on a
    // parentless replaceWith, so stub it the way the widget DOM contract allows).
    img.replaceWith = ((...nodes: Node[]) => { void nodes }) as HTMLImageElement["replaceWith"]
    ;(img.onerror as ((e: Event) => void) | null)?.(new Event("error"))
    expect(measures).toBe(0)

    const attached = new ImageWidget("missing.png", "alt", "/missing.png")
      .toDOM(fakeView(() => { measures++ })) as HTMLImageElement
    parent.appendChild(attached)
    ;(attached.onerror as ((e: Event) => void) | null)?.(new Event("error"))

    const span = parent.querySelector(".omd-image-broken") as HTMLElement
    expect(span).toBeTruthy()
    expect(span.textContent).toBe("broken:missing.png")
    expect(measures).toBe(1)
    parent.remove()
  })
})
