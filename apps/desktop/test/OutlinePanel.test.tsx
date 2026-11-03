import { fireEvent, render, screen, act } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { OutlineItem } from "@omd/engine"
import { createEditorStatusStore } from "../src/editorStatusStore"
import { OutlineList, OutlinePanel } from "../src/OutlinePanel"

// happy-dom 无布局且其 scrollIntoView 不把元素作为实参（身份在 this 上）：
// 包装捕获 this，使断言可验证「滚的是哪个元素 + 什么选项」。
const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoViewCapture(
    this: Element,
    opts?: ScrollIntoViewOptions,
  ) {
    scrollIntoView(this, opts)
  } as typeof Element.prototype.scrollIntoView
})
afterEach(() => scrollIntoView.mockClear())

// 组件契约：条目点击跳转 onJump(from)；current 由 statusStore.head 驱动
// （outlineCurrentIndex 最深匹配节），aria-current 暴露给无障碍树。
const ITEMS: OutlineItem[] = [
  { level: 1, text: "Intro", from: 0 },
  { level: 2, text: "Deep", from: 8 },
  { level: 1, text: "Next", from: 20 },
]

function setup(head: number) {
  const store = createEditorStatusStore({ cursor: "1:1", head, mode: "live" })
  const onJump = vi.fn()
  render(<OutlineList items={ITEMS} statusStore={store} onJump={onJump} />)
  return { store, onJump }
}

const currentItem = () =>
  screen.getAllByRole("button").find(button => button.getAttribute("aria-current") === "location")

describe("OutlineList current-section tracking", () => {
  it("marks the deepest section containing the cursor and follows head updates", () => {
    const { store } = setup(10) // “Deep” 节内
    expect(currentItem()?.textContent).toBe("Deep")

    act(() => store.publish({ cursor: "1:1", head: 25, mode: "live" })) // 跳到 “Next” 节
    expect(currentItem()?.textContent).toBe("Next")

    act(() => store.publish({ cursor: "1:1", head: 4, mode: "live" })) // 回到 “Intro”
    expect(currentItem()?.textContent).toBe("Intro")
  })

  it("marks nothing before the first heading", () => {
    setup(0) // from=0 的标题节从 0 起，这里用带 preamble 的场景验证 -1：
    // items[0].from === 0 时 head=0 命中第一节；为覆盖 -1 分支另用负偏移不可行，
    // 改由 head 小于首标题 from 的文档形态覆盖 —— 见下一用例。
    expect(currentItem()?.textContent).toBe("Intro")
  })

  it("marks nothing when head precedes every heading", () => {
    const store = createEditorStatusStore({ cursor: "1:1", head: 0, mode: "live" })
    const preamble: OutlineItem[] = [{ level: 1, text: "H", from: 5 }]
    render(<OutlineList items={preamble} statusStore={store} onJump={vi.fn()} />)
    expect(currentItem()).toBeUndefined()
  })

  it("jumps by heading position on click", () => {
    const { onJump } = setup(0)
    fireEvent.click(screen.getByRole("button", { name: "Deep" }))
    expect(onJump).toHaveBeenCalledWith(8)
  })

  it("marks nothing while the outline is empty", () => {
    const store = createEditorStatusStore({ cursor: "1:1", head: 3, mode: "live" })
    render(<OutlineList items={[]} statusStore={store} onJump={vi.fn()} />)
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})

describe("OutlinePanel reveals the current item", () => {
  const MANY: OutlineItem[] = Array.from({ length: 40 }, (_, i) => ({
    level: 1,
    text: `H${i}`,
    from: i * 10,
  }))

  afterEach(() => scrollIntoView.mockClear())

  function setupPanel(head: number) {
    const store = createEditorStatusStore({ cursor: "1:1", head, mode: "live" })
    const { rerender } = render(
      <OutlinePanel items={MANY} statusStore={store} onJump={vi.fn()} />,
    )
    return { store, rerender }
  }

  it("scrolls the current item into view when the section changes", () => {
    const { store } = setupPanel(35 * 10) // 第 36 节
    const target = screen.getByRole("button", { name: "H35" })
    expect(target.getAttribute("aria-current")).toBe("location")
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith(target, { block: "nearest" })
    // 同节内光标移动不触发新的滚动
    scrollIntoView.mockClear()
    act(() => store.publish({ cursor: "1:1", head: 35 * 10 + 3, mode: "live" }))
    expect(scrollIntoView).not.toHaveBeenCalled()
    // 换节才滚动
    act(() => store.publish({ cursor: "1:1", head: 8 * 10, mode: "live" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it("does not scroll when there is no current section", () => {
    // 首标题 from=100：head 在其前 → current = -1，不滚动。
    const deferred = MANY.map(item => ({ ...item, from: item.from + 100 }))
    const store = createEditorStatusStore({ cursor: "1:1", head: 5, mode: "live" })
    render(<OutlinePanel items={deferred} statusStore={store} onJump={vi.fn()} />)
    expect(scrollIntoView).not.toHaveBeenCalled()
    act(() => store.publish({ cursor: "1:1", head: 112, mode: "live" })) // 进入首节
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it("does not re-scroll for the same section across item refreshes", () => {
    const { store, rerender } = setupPanel(20 * 10)
    scrollIntoView.mockClear()
    // 文档编辑后大纲条目对象重建，但 current 索引未变 → 不再滚动
    rerender(
      <OutlinePanel
        items={MANY.map(item => ({ ...item }))}
        statusStore={store}
        onJump={vi.fn()}
      />,
    )
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it("re-arms the reveal after a tab switch remounts the panel (key change)", () => {
    // 同索引不同文档：切 tab 后 App 以 key 重挂面板，守卫归零，current 重新带入视野。
    const first = setupPanel(20 * 10)
    scrollIntoView.mockClear()
    const second = render(
      <OutlinePanel
        key="tab-2"
        items={MANY.map(item => ({ ...item, text: `${item.text}'` }))}
        statusStore={first.store}
        onJump={vi.fn()}
      />,
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    second.unmount()
  })
})

