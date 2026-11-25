// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { editorExtensions, type MediaInspectTarget } from "../src/index"
import { drainPendingLiveBuild } from "../src/decorations/build"
import { clearMermaidSvgCacheForTest, MermaidWidget } from "../src/decorations/widgets/mermaid"
import { instantiateCachedMermaidSvg } from "../src/decorations/widgets/mermaidSvgCache"
import { clearImageDimensionsCacheForTest, ImageWidget } from "../src/decorations/widgets/image"

function clickElement(el: Element, init: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20, ...init }))
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20, ...init }))
}

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, src: string) => ({
      svg: `<svg id="${id}" class="omd-mermaid-svg" viewBox="0 0 400 200"><text>${src}</text></svg>`,
    })),
  },
}))

function mountEditor(
  doc: string,
  options: {
    onInspectMedia?: (target: MediaInspectTarget) => void
    readOnly?: boolean
    cursor?: number
  } = {},
) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: options.cursor ?? doc.length },
      extensions: [
        EditorView.exceptionSink.of(err => errors.push(err)),
        options.readOnly ? EditorState.readOnly.of(true) : [],
        editorExtensions({
          resolveImageSrc: src => `resolved://${src}`,
          onInspectMedia: options.onInspectMedia,
        }),
      ],
    }),
    parent,
  })
  drainPendingLiveBuild(view)
  return {
    view,
    errors,
    cleanup: () => {
      view.destroy()
      parent.remove()
    },
  }
}

describe("media inspection (ImageWidget & MermaidWidget)", () => {
  it("invokes onInspectMedia on confirmed click of an image without unfolding it, and editSource unfolds it", () => {
    const inspected: MediaInspectTarget[] = []
    const { view, errors, cleanup } = mountEditor('![diagram](arch.png "Architecture")\n\ntail', {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      expect(view.dom.getAttribute("data-omd-media-inspect")).toBe("true")
      const img = view.dom.querySelector<HTMLImageElement>("img.omd-image")
      expect(img).toBeTruthy()

      clickElement(img!)
      expect(inspected).toHaveLength(1)
      expect(inspected[0]).toMatchObject({
        kind: "image",
        src: "arch.png",
        resolvedSrc: "resolved://arch.png",
        alt: "diagram",
        title: "Architecture",
      })
      // Still rendered as an image (did not collapse to source)
      expect(view.dom.querySelector("img.omd-image")).toBeTruthy()
      expect(typeof inspected[0].editSource).toBe("function")

      // Invoking editSource moves caret into the image node and reveals raw Markdown
      inspected[0].editSource!()
      expect(view.state.selection.main.from).toBe(0)
      expect(view.dom.querySelector("img.omd-image")).toBeNull()
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("cancels image inspection when pointer drags past drift threshold before mouseup", () => {
    const inspected: MediaInspectTarget[] = []
    const { view, errors, cleanup } = mountEditor("![alt](pic.png)\n\ntail", {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      const img = view.dom.querySelector<HTMLImageElement>("img.omd-image")!
      img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20 }))
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 20 }))
      expect(inspected).toHaveLength(0)
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("ignores Alt+Click on an image so the user can bypass the lightbox", () => {
    const inspected: MediaInspectTarget[] = []
    const { view, errors, cleanup } = mountEditor("![alt](pic.png)\n\ntail", {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      const img = view.dom.querySelector<HTMLImageElement>("img.omd-image")!
      img.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, button: 0, altKey: true,
      }))
      expect(inspected).toHaveLength(0)
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("omits editSource when the editor is read-only", () => {
    const inspected: MediaInspectTarget[] = []
    const { view, errors, cleanup } = mountEditor("![alt](pic.png)\n\ntail", {
      onInspectMedia: target => inspected.push(target),
      readOnly: true,
    })
    try {
      const img = view.dom.querySelector<HTMLImageElement>("img.omd-image")!
      clickElement(img)
      expect(inspected).toHaveLength(1)
      expect(inspected[0].editSource).toBeUndefined()
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("does not mark editor inspectable when no onInspectMedia handler is configured", () => {
    const { view, errors, cleanup } = mountEditor("![alt](pic.png)\n\ntail")
    try {
      expect(view.dom.getAttribute("data-omd-media-inspect")).toBeNull()
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("invokes onInspectMedia when clicking a rendered Mermaid diagram, while edit button still enters source", async () => {
    const inspected: MediaInspectTarget[] = []
    const doc = "```mermaid\ngraph LR\n  A --> B\n```\n\ntail"
    const { view, errors, cleanup } = mountEditor(doc, {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      // Wait for Mermaid's 500ms debounce + mock render
      await new Promise(resolve => setTimeout(resolve, 600))
      const wrap = view.dom.querySelector<HTMLElement>(".omd-mermaid")
      expect(wrap).toBeTruthy()
      const svg = wrap!.querySelector("svg.omd-mermaid-svg")
      expect(svg).toBeTruthy()

      // Clicking the rendered diagram opens inspection instead of collapsing to source
      clickElement(svg!)
      expect(inspected).toHaveLength(1)
      expect(inspected[0].kind).toBe("mermaid")
      if (inspected[0].kind === "mermaid") {
        expect(inspected[0].source).toContain("graph LR")
      }
      expect(view.dom.querySelector(".omd-mermaid")).toBeTruthy()

      // Clicking the explicit </> button enters source
      const editBtn = wrap!.querySelector<HTMLButtonElement>(".omd-block-edit")!
      editBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
      expect(view.dom.querySelector(".omd-mermaid")).toBeNull()
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  }, 2000)

  it("falls back to entering source when clicking a Mermaid placeholder before SVG renders", () => {
    clearMermaidSvgCacheForTest()
    const inspected: MediaInspectTarget[] = []
    const doc = "```mermaid\ngraph TD; A-->B\n```\n\ntail"
    const { view, errors, cleanup } = mountEditor(doc, {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".omd-mermaid")!
      const pre = wrap.querySelector(".omd-block-placeholder")!
      pre.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
      expect(inspected).toHaveLength(0)
      expect(view.dom.querySelector(".omd-mermaid")).toBeNull()
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("renders cached Mermaid diagrams synchronously (0ms) with unique SVG ids", async () => {
    clearMermaidSvgCacheForTest()
    const diagram = "graph LR\n  CacheA --> CacheB"
    const fakeView = {
      requestMeasure: () => {},
      posAtDOM: () => 0,
      dispatch: () => {},
      focus: () => {},
      state: { facet: () => null, readOnly: false },
    } as unknown as EditorView

    const first = new MermaidWidget(diagram, 0)
    const firstDom = first.toDOM(fakeView)
    expect(firstDom.querySelector(".omd-block-body")?.getAttribute("data-omd-render")).toBe("placeholder")
    await new Promise(resolve => setTimeout(resolve, 600))
    const firstSvg = firstDom.querySelector<SVGSVGElement>("svg.omd-mermaid-svg")
    expect(firstSvg).toBeTruthy()
    const firstId = firstSvg!.id

    // Second widget with identical source renders synchronously in toDOM (0ms, zero async dispatches)
    let secondDispatches = 0
    let secondMeasures = 0
    const secondView = {
      requestMeasure: () => { secondMeasures += 1 },
      posAtDOM: () => 0,
      dispatch: () => { secondDispatches += 1 },
      focus: () => {},
      state: { facet: () => null, readOnly: false },
    } as unknown as EditorView
    const second = new MermaidWidget(diagram, 0)
    const secondDom = second.toDOM(secondView)
    expect(secondDom.querySelector(".omd-block-body")?.getAttribute("data-omd-render")).toBe("svg")
    const secondSvg = secondDom.querySelector<SVGSVGElement>("svg.omd-mermaid-svg")
    expect(secondSvg).toBeTruthy()
    expect(secondSvg!.id).not.toBe(firstId)
    await Promise.resolve()
    expect(secondMeasures).toBe(0)
    expect(secondDispatches).toBe(0)

    first.destroy(firstDom)
    second.destroy(secondDom)
  }, 2000)

  it("rewrites cached Mermaid SVG ids without corrupting longer numeric prefixes", () => {
    const out = instantiateCachedMermaidSvg(
      {
        id: "omd-mmd-1",
        svg: '<svg id="omd-mmd-1"><style>#omd-mmd-1 .n{}</style><text>omd-mmd-10</text></svg>',
      },
      "omd-mmd-99",
    )
    expect(out).toContain('id="omd-mmd-99"')
    expect(out).toContain("#omd-mmd-99 .n")
    expect(out).toContain("<text>omd-mmd-10</text>")
  })

  it("caches natural image dimensions and calls requestMeasure on load", () => {
    clearImageDimensionsCacheForTest()
    let measures = 0
    const fakeView = {
      requestMeasure: () => { measures += 1 },
      state: { facet: () => null },
    } as unknown as EditorView

    const first = new ImageWidget("hero.png", "Hero", "resolved://hero.png")
    const img1 = first.toDOM(fakeView) as HTMLImageElement
    document.body.appendChild(img1)
    try {
      expect(img1.decoding).toBe("async")
      Object.defineProperty(img1, "naturalWidth", { value: 1200, configurable: true })
      Object.defineProperty(img1, "naturalHeight", { value: 600, configurable: true })
      img1.onload?.(new Event("load"))
      expect(measures).toBe(1)
    } finally {
      img1.remove()
    }

    const second = new ImageWidget("hero.png", "Hero", "resolved://hero.png")
    const img2 = second.toDOM(fakeView) as HTMLImageElement
    expect(img2.width).toBe(1200)
    expect(img2.height).toBe(600)
  })

  it("invokes onInspectMedia when clicking an image inside a rendered GFM table", async () => {
    const inspected: MediaInspectTarget[] = []
    const doc = '| Col |\n| --- |\n| ![cell-pic](cell.png "Cell title") |\n\ntail'
    const { view, errors, cleanup } = mountEditor(doc, {
      onInspectMedia: target => inspected.push(target),
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      const img = view.dom.querySelector<HTMLImageElement>(".omd-table img.omd-image")
      expect(img).toBeTruthy()
      clickElement(img!)
      expect(inspected).toHaveLength(1)
      expect(inspected[0]).toMatchObject({
        kind: "image",
        src: "cell.png",
        resolvedSrc: "resolved://cell.png",
        alt: "cell-pic",
        title: "Cell title",
      })
      expect(errors).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("MermaidWidget without handler enters source on click", () => {
    clearMermaidSvgCacheForTest()
    let dispatched = false
    const fakeView = {
      requestMeasure: () => {},
      posAtDOM: () => 0,
      dispatch: () => { dispatched = true },
      focus: () => {},
      state: { facet: () => null, readOnly: false },
    } as unknown as EditorView
    const widget = new MermaidWidget("graph TD; A-->B", 0)
    const dom = widget.toDOM(fakeView)
    dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    expect(dispatched).toBe(true)
    widget.destroy(dom)
  })

  it("re-renders mounted MermaidWidget live on light/dark theme toggle and cleans up on destroy", async () => {
    clearMermaidSvgCacheForTest()
    document.documentElement.dataset.theme = "light"
    const { default: mermaid } = await import("mermaid")
    vi.mocked(mermaid.render).mockClear()

    let measures = 0
    const fakeView = {
      requestMeasure: () => { measures += 1 },
      posAtDOM: () => 0,
      dispatch: () => {},
      focus: () => {},
      state: { facet: () => null, readOnly: false },
    } as unknown as EditorView

    const widget = new MermaidWidget("graph LR\n  ThemeA --> ThemeB", 0)
    const dom = widget.toDOM(fakeView)
    document.body.appendChild(dom)
    try {
      await new Promise(resolve => setTimeout(resolve, 160))
      expect(vi.mocked(mermaid.render)).toHaveBeenCalledTimes(1)
      const lightId = dom.querySelector("svg.omd-mermaid-svg")?.id
      expect(lightId).toBeTruthy()

      // Flip to dark mode -> already-mounted widget re-renders automatically.
      document.documentElement.dataset.theme = "dark"
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(vi.mocked(mermaid.render)).toHaveBeenCalledTimes(2)
      const darkId = dom.querySelector("svg.omd-mermaid-svg")?.id
      expect(darkId).toBeTruthy()
      expect(darkId).not.toBe(lightId)
      expect(measures).toBeGreaterThanOrEqual(2)

      // Flip back to light -> hits the light theme cache synchronously (no 3rd mermaid.render call).
      document.documentElement.dataset.theme = "light"
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(vi.mocked(mermaid.render)).toHaveBeenCalledTimes(2)

      // After destroy, further theme switches must not trigger renders.
      widget.destroy(dom)
      document.documentElement.dataset.theme = "dark"
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(vi.mocked(mermaid.render)).toHaveBeenCalledTimes(2)
    } finally {
      widget.destroy(dom)
      dom.remove()
      document.documentElement.removeAttribute("data-theme")
    }
  })
})
