// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockInitialize = vi.fn()
const mockParse = vi.fn()
const mockRender = vi.fn()

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    parse: mockParse,
    render: mockRender,
  },
}))

const {
  clearMermaidSvgCache,
  normalizeMermaidError,
  renderMermaidSvg,
  subscribeDocumentMermaidTheme,
} = await import("../src/mermaid/renderer")

describe("renderMermaidSvg", () => {
  beforeEach(() => {
    clearMermaidSvgCache()
    mockInitialize.mockReset()
    mockParse.mockReset().mockResolvedValue(true)
    mockRender.mockReset()
    document.documentElement.removeAttribute("data-theme")
  })

  it("serializes concurrent renders and re-initializes only when theme changes", async () => {
    let active = 0
    let maxConcurrent = 0
    mockRender.mockImplementation(async (id: string, src: string) => {
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
      return { svg: `<svg id="${id}">${src}</svg>` }
    })

    const [a, b, c] = await Promise.all([
      renderMermaidSvg("graph TD; A-->B", { theme: "light", useCache: false }),
      renderMermaidSvg("graph TD; C-->D", { theme: "dark", useCache: false }),
      renderMermaidSvg("graph TD; E-->F", { theme: "dark", useCache: false }),
    ])

    expect(maxConcurrent).toBe(1)
    expect(a.svg).toContain("A-->B")
    expect(b.svg).toContain("C-->D")
    expect(c.svg).toContain("E-->F")
    // Light -> Dark -> Dark should initialize twice (light, then dark).
    expect(mockInitialize).toHaveBeenCalledTimes(2)
    expect(mockInitialize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "default",
    }))
    expect(mockInitialize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      theme: "dark",
    }))
  })

  it("isolates cache entries by theme so dark and light renders never collide", async () => {
    mockRender.mockImplementation(async (id: string) => ({
      svg: `<svg id="${id}" data-call="${mockRender.mock.calls.length}"></svg>`,
    }))

    const light1 = await renderMermaidSvg("graph LR; X-->Y", { theme: "light" })
    const light2 = await renderMermaidSvg("graph LR; X-->Y", { theme: "light" })
    const dark1 = await renderMermaidSvg("graph LR; X-->Y", { theme: "dark" })

    expect(light2.svg).toBe(light1.svg)
    expect(dark1.svg).not.toBe(light1.svg)
    expect(mockRender).toHaveBeenCalledTimes(2)
  })

  it("normalizes non-Error Mermaid rejections and cleans up stray scratch containers", async () => {
    const stray = document.createElement("div")
    stray.id = "domd-stray-1"
    document.body.appendChild(stray)

    mockParse.mockRejectedValueOnce({ str: "Parse error on line 2" })

    await expect(
      renderMermaidSvg("bad syntax", { id: "omd-stray-1", useCache: false }),
    ).rejects.toThrow("Parse error on line 2")

    expect(document.getElementById("domd-stray-1")).toBeNull()
    expect(normalizeMermaidError({ message: "Boom" }).message).toBe("Boom")
    expect(normalizeMermaidError({ str: "Syntax fail" }).message).toBe("Syntax fail")
    expect(normalizeMermaidError("raw").message).toBe("raw")
  })

  it("notifies theme subscribers on data-theme transitions and stops after unsubscribe", async () => {
    const flushObserver = () => new Promise(resolve => setTimeout(resolve, 0))
    document.documentElement.dataset.theme = "light"
    const seen: string[] = []
    const unsub = subscribeDocumentMermaidTheme(theme => seen.push(theme))

    document.documentElement.dataset.theme = "dark"
    await flushObserver()
    document.documentElement.dataset.theme = "dark"
    await flushObserver()
    document.documentElement.dataset.theme = "light"
    await flushObserver()

    unsub()
    document.documentElement.dataset.theme = "dark"
    await flushObserver()

    expect(seen).toEqual(["dark", "light"])
  })
})
