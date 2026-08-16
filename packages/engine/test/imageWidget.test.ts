import { expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { editorExtensions, imageBrokenLabel } from "../src/index"
import { ImageWidget } from "../src/decorations/widgets/image"

it("wires injected imageBrokenLabel into the facet", () => {
  const state = EditorState.create({
    doc: "",
    extensions: [editorExtensions({ imageBrokenLabel: src => `broken:${src}` })],
  })
  expect(state.facet(imageBrokenLabel)("foo.png")).toBe("broken:foo.png")
})

it("falls back to default label when no option is given", () => {
  const state = EditorState.create({
    doc: "",
    extensions: [editorExtensions({})],
  })
  const label = state.facet(imageBrokenLabel)("bar.png")
  expect(label).toContain("bar.png")
  expect(label).toContain("加载失败")
})

it("toDOM uses the facet label on image error", () => {
  const labelFn = (src: string) => `[zh] ${src} 失败`
  const fakeView = {
    state: { facet: (f: unknown) => (f === imageBrokenLabel ? labelFn : null) },
  } as unknown as EditorView
  const widget = new ImageWidget("missing.png", "alt", "missing.png")
  const img = widget.toDOM(fakeView) as HTMLImageElement
  expect(img.className).toBe("omd-image")
  expect(img.alt).toBe("alt")

  const replaced: Node[] = []
  img.replaceWith = ((...nodes: Node[]) => { replaced.push(...nodes); return }) as HTMLImageElement["replaceWith"]
  ;(img.onerror as ((e: Event) => void) | null)?.(new Event("error"))
  expect(replaced).toHaveLength(1)
  const span = replaced[0] as HTMLElement
  expect(span.className).toBe("omd-image-broken")
  expect(span.textContent).toBe("[zh] missing.png 失败")
})
