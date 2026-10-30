import { describe, expect, it } from "vitest"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { collectDecorationSpecs, livePreviewField } from "../src/decorations/build"
import { makeState } from "./helpers"
import { editorExtensions, imageBrokenLabel } from "../src/index"
import { referenceIndexScanStats } from "../src/semantic/references"
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

// —— 语义图片投影（inline / reference 共用 imageParts）——

/** 光标停在文末的 'x' 行，图片所在行处于渲染态。 */
function imageWidget(doc: string, extra: Extension[] = []) {
  const state = makeState(`${doc}\n\nx`, extra)
  const final = state.update({ selection: { anchor: state.doc.length } }).state
  const spec = collectDecorationSpecs(final, 0, final.doc.length)
    .find(item => item.tag === "widget:image")
  return spec?.deco.spec.widget as ImageWidget | undefined
}

function imageSpecs(doc: string, extra: Extension[] = []) {
  const state = makeState(`${doc}\n\nx`, extra)
  const final = state.update({ selection: { anchor: state.doc.length } }).state
  return collectDecorationSpecs(final, 0, final.doc.length)
    .filter(item => item.tag === "widget:image")
}

describe("ImageWidget DOM", () => {
  it("sets img.title for a non-empty title and leaves it empty otherwise", () => {
    const fakeView = { state: { facet: () => null } } as unknown as EditorView
    expect(new ImageWidget("a.png", "alt", "a.png", "caption").toDOM(fakeView).title).toBe("caption")
    expect(new ImageWidget("a.png", "alt", "a.png", null).toDOM(fakeView).title).toBe("")
    expect(new ImageWidget("a.png", "alt", "a.png", "").toDOM(fakeView).title).toBe("")
  })
})

describe("ImageWidget eq", () => {
  const base = () => new ImageWidget("a.png", "alt", "/a.png", "cap")

  it("compares every field it renders", () => {
    expect(base().eq(new ImageWidget("a.png", "alt", "/a.png", "cap"))).toBe(true)
    expect(base().eq(new ImageWidget("b.png", "alt", "/a.png", "cap"))).toBe(false)
    expect(base().eq(new ImageWidget("a.png", "other", "/a.png", "cap"))).toBe(false)
    expect(base().eq(new ImageWidget("a.png", "alt", "/b.png", "cap"))).toBe(false)
    expect(base().eq(new ImageWidget("a.png", "alt", "/a.png", "other"))).toBe(false)
    expect(base().eq(new ImageWidget("a.png", "alt", "/a.png"))).toBe(false)
  })
})

describe("inline image decoration", () => {
  it("renders a plain inline image (regression)", () => {
    const widget = imageWidget("![alt](pic.png)")
    expect(widget).toBeInstanceOf(ImageWidget)
    expect(widget!.src).toBe("pic.png")
    expect(widget!.alt).toBe("alt")
    expect(widget!.title).toBeNull()
  })

  it("projects formatted and entity-decoded alt text with the title", () => {
    const widget = imageWidget('![a *b* &amp; c](a.png "caption")')
    expect(widget!.alt).toBe("a b & c")
    expect(widget!.src).toBe("a.png")
    expect(widget!.title).toBe("caption")
  })

  it("resolves a reference image from the indexed context", () => {
    const widget = imageWidget('![ref][id]\n\n[id]: img.png "title"')
    expect(widget).toBeInstanceOf(ImageWidget)
    expect(widget!.src).toBe("img.png")
    expect(widget!.alt).toBe("ref")
    expect(widget!.title).toBe("title")
  })

  it("keeps an unresolved reference image source-visible", () => {
    expect(imageSpecs("![x][missing]")).toEqual([])
    expect(imageSpecs("![x]")).toEqual([])
  })

  it("hands the semantic resolved src to the host image resolver", () => {
    const seen: string[] = []
    const widget = imageWidget('![r][id]\n\n[id]: ref.png', [
      editorExtensions({ resolveImageSrc: src => { seen.push(src); return `asset://${src}` } }),
    ])
    // 解析次数是实现细节（种子构建 / 收集 / 重配置都可能解析）—— 只关心拿到的是语义 src。
    expect(new Set(seen)).toEqual(new Set(["ref.png"]))
    expect(widget!.resolvedSrc).toBe("asset://ref.png")
  })
})

// —— 定义变更后重建已挂载的图片投影（字段级，不靠全量重建）——

function mountLive(doc: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [editorExtensions({})],
    }),
    parent,
  })
  return { view, parent }
}

function imageOf(view: EditorView) {
  return view.state.field(livePreviewField).specs
    .find(spec => spec.tag === "widget:image")?.deco.spec.widget as ImageWidget | undefined
}

function imgDom(view: EditorView) {
  return view.dom.querySelector("img.omd-image") as HTMLImageElement | null
}

describe("reference definition edits", () => {
  // 引用定义自成块：编辑它时脏区只覆盖包含该定义的顶层块，不在同一块的图片不会被
  // 重建 —— 图片要跟着定义变，只能靠语义依赖触发重建（否则就是本文要修的陈旧投影）。
  const doc = '![ref][id]\n\nplain text\n\n[id]: a.png "one"\n# heading'
  const replace = (view: EditorView, needle: string, insert: string) => {
    const from = view.state.doc.toString().indexOf(needle)
    view.dispatch({ changes: { from, to: from + needle.length, insert } })
  }

  it("reprojects a mounted reference image when the definition target changes", () => {
    const { view, parent } = mountLive(doc)
    expect(imageOf(view)?.src).toBe("a.png")
    expect(imageOf(view)?.title).toBe("one")
    expect(imgDom(view)?.getAttribute("src")).toBe("a.png")
    expect(imgDom(view)?.getAttribute("title")).toBe("one")
    const before = imageOf(view)

    replace(view, "a.png", "b.png")

    expect(imageOf(view)?.src).toBe("b.png")
    expect(imageOf(view)?.title).toBe("one")
    expect(imageOf(view)).not.toBe(before)
    expect(imgDom(view)?.getAttribute("src")).toBe("b.png")

    replace(view, '"one"', '"two"')

    expect(imageOf(view)?.title).toBe("two")
    expect(imgDom(view)?.getAttribute("title")).toBe("two")
    view.destroy()
    parent.remove()
  })

  it("unmounts the image when the definition is removed", () => {
    const { view, parent } = mountLive(doc)
    expect(imageOf(view)).toBeInstanceOf(ImageWidget)

    const def = '[id]: a.png "one"'
    const from = view.state.doc.toString().indexOf(def)
    view.dispatch({ changes: { from, to: from + def.length + 1 } })

    expect(imageOf(view)).toBeUndefined()
    expect(imgDom(view)).toBeNull()
    expect(view.state.field(livePreviewField).specs.some(spec => spec.tag === "widget:image"))
      .toBe(false)
    // 源码重新可见：装饰没把 `![ref][id]` 换成空白
    expect(view.dom.textContent).toContain("![ref][id]")
    view.destroy()
    parent.remove()
  })

  it("keeps resolver and widget identity on an unrelated text edit", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `paragraph ${i}`).join("\n\n")
    const text = `![ref][id]\n\n${paragraphs}\n\n[id]: a.png`
    const { view, parent } = mountLive(text)
    const before = imageOf(view)
    expect(before).toBeInstanceOf(ImageWidget)

    referenceIndexScanStats.reset()
    const pos = view.state.doc.toString().indexOf("paragraph 7") + 3
    view.dispatch({ changes: { from: pos, insert: "X" } })

    // widget 对象复用 = 引用定义未变，投影没有被无谓重组
    expect(imageOf(view)).toBe(before)
    // 只有被编辑的块被重新扫描（整篇 14 个顶层块），不是全文档扫描
    expect(referenceIndexScanStats.scannedBlocks).toBeLessThanOrEqual(2)
    view.destroy()
    parent.remove()
  })
})
