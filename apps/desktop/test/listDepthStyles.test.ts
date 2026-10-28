import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// 列表深度是引擎的语义值（`--omd-list-depth` 行内自定义属性 + 一个稳定类），
// 视觉换算只在 CSS：这里守的是"没有 per-depth 类、宽度由变量推导"。
const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

// 取最后一个匹配：具体规则写在合写规则之后（如 padding 合寫里的选择器行也会命中）。
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = [...STYLES_CSS.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
  if (matches.length === 0) throw new Error(`missing styles.css rule for ${selector}`)
  return matches[matches.length - 1][1]
}

// 组合选择器（规则里有两个选择器时）按原始文本整段匹配：rule() 要求选择器后面直接是 `{`。
const FLAT_CSS = STYLES_CSS.replace(/\s+/g, " ")
function ruleFor(selectors: string): string {
  const escaped = selectors.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = FLAT_CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`missing styles.css rule for ${selectors}`)
  return match[1]
}

// 真实样式表挂进 happy-dom：级联 + var() 代入是真的，能抓到"后写的合写
// (padding: …) 把左侧缩进清零"这类毛病 —— 只断言声明存在则抓不到。
// happy-dom 只解单变量 calc（第二个带 fallback 的 var() 会塌回重置值），
// 所以 quote-in-list 这几档由 e2e/list-depth.spec.ts 在真实浏览器里补,
// 两边读的是同一份 styles.css。
function computed(html: string, selector: string): CSSStyleDeclaration {
  const style = document.createElement("style")
  style.textContent = STYLES_CSS.replace(/^@import[^\n]*\n/m, "")
  document.head.replaceChildren(style)
  const host = document.createElement("div")
  host.className = "editor-host"
  host.innerHTML = html
  document.body.replaceChildren(host)
  const el = host.querySelector(selector)
  if (!el) throw new Error(`missing element for ${selector}`)
  return getComputedStyle(el)
}

// happy-dom 把代入后的 calc 原样打出来（"calc(3 * 19.2px)"）：取 "深度 * em尺寸" 的积。
function listOffsetPx(paddingLeft: string): number {
  const match = paddingLeft.match(/([\d.]+)\s*\*\s*([\d.]+)px/)
  if (!match) throw new Error(`unresolved list padding: ${paddingLeft}`)
  return Number(match[1]) * Number(match[2])
}

const CODE_AT_DEPTH_3 = `
  <div class="omd-block omd-code omd-li" style="--omd-list-depth:3">
    <div class="omd-code-header omd-li" style="--omd-list-depth:3"></div>
    <div class="omd-block-body omd-code-body"></div>
  </div>`

describe("unbounded list depth styling", () => {
  it("derives list padding from --omd-list-depth instead of numbered classes", () => {
    expect(STYLES_CSS).toContain("--omd-li-pad: calc(var(--omd-list-depth) * 1.2em)")
    expect(STYLES_CSS).not.toMatch(/\.omd-li-\d/)
    expect(STYLES_CSS).not.toMatch(/\.omd-quote-in-li-\d/)
  })

  it("pads list and quote-in-list lines from that variable", () => {
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.omd-li,\s*\.editor-host \.omd-quote-in-li\s*\{[^}]*padding-left:\s*calc\(var\(--omd-bq-pad, 0px\) \+ var\(--omd-li-pad, 0px\)\)/,
    )
  })

  it("keeps the hanging-indent contracts", () => {
    expect(rule(".editor-host .omd-li")).toMatch(/--omd-li-hang:\s*-1\.2em/)
    const quoteInList = rule(".editor-host .omd-quote-in-li")
    expect(quoteInList).toMatch(/--omd-bq-bar:\s*var\(--omd-li-pad\)/)
    expect(quoteInList).toMatch(/--omd-li-hang:\s*0/)
    expect(rule(".editor-host .omd-block.omd-li")).toMatch(/--omd-li-hang:\s*0/)
  })

  it("offsets an ordinary block widget once, after its own padding shorthand", () => {
    // 后写的 .omd-block / .omd-math / .omd-table / .omd-code 合写会把左侧清零：
    // 块 widget 的深度偏移必须在这之后重新声明（更高特异性，不靠 !important）。
    expect(ruleFor(".editor-host .omd-block.omd-li, .editor-host .omd-block.omd-quote-in-li"))
      .toMatch(/padding-left:\s*calc\(var\(--omd-bq-pad, 0px\) \+ var\(--omd-li-pad, 0px\)\)/)
    // 深度 0 / 非列表块未被新规则命中：padding-left 仍是 0px。
    expect(computed(`<div class="omd-block omd-math"></div>`, ".omd-block").paddingLeft).toBe("0px")
    expect(computed(`<div class="omd-block omd-code"></div>`, ".omd-code").paddingLeft).toBe("0px")
    // 代码块的 wrapper 只取列表偏移，引用缩进留在 header（否则两处各加一次）。
    expect(ruleFor(".editor-host .omd-block.omd-code.omd-li, .editor-host .omd-block.omd-code.omd-quote-in-li"))
      .toMatch(/padding-left:\s*var\(--omd-li-pad, 0px\)/)
  })

  it("keeps the vertical padding of the widget it indents", () => {
    expect(computed(`<div class="omd-block"></div>`, ".omd-block").paddingTop).toBe("8px")
    expect(computed(`<div class="omd-block omd-math"></div>`, ".omd-math").paddingTop).toBe("4px")
    expect(computed(`<div class="omd-block omd-table"></div>`, ".omd-table").paddingTop).toBe("12.8px")
  })

  it("gives a rendered code widget exactly one list offset", () => {
    const wrapper = computed(CODE_AT_DEPTH_3, ".omd-code")
    expect(listOffsetPx(wrapper.paddingLeft)).toBeCloseTo(3 * 1.2 * parseFloat(wrapper.fontSize))
    // header/body 已经随 wrapper 的 padding 一起位移，不能各自再加一次。
    expect(computed(CODE_AT_DEPTH_3, ".omd-code-header").paddingLeft).toBe("10px")
    expect(computed(CODE_AT_DEPTH_3, ".omd-block-body").paddingLeft).toBe("0px")
  })

  it("puts the editing chrome's own list offset in its padding", () => {
    // 编辑态 chrome 是独立块 widget（没有 .omd-code wrapper），整段缩进由它自己承担。
    expect(ruleFor(
      ".editor-host .cm-content > .omd-code-header.omd-li, .editor-host .cm-content > .omd-code-header.omd-quote-in-li",
    )).toMatch(/padding-left:\s*calc\(var\(--omd-bq-pad, 0px\) \+ var\(--omd-li-pad, 0px\) \+ 10px\)/)
    // 非列表 chrome 保持原样（10px 基准内缩）。
    expect(computed(`<div class="cm-content"><div class="omd-code-header"></div></div>`, ".omd-code-header")
      .paddingLeft).toBe("10px")
  })

  it("draws the quote-in-list bar from the one list offset, never from both boxes", () => {
    // 引用条只活在 background-image 的渐变上，起点是 --omd-bq-bar。
    // 源码行/块 widget：起点 = 列表缩进本身。
    const line = computed(
      `<div class="cm-line omd-blockquote-1 omd-quote-in-li" style="--omd-list-depth:2"></div>`,
      ".cm-line",
    )
    expect(line.getPropertyValue("--omd-bq-bar").trim()).toBe(line.getPropertyValue("--omd-li-pad").trim())
    // 渲染态代码块的 header 已经在 wrapper 的缩进里：它自己的渐变必须从 0 起画，
    // 否则会落在第二个列表偏移上（双重缩进）。
    const header = computed(
      `<div class="omd-block omd-code omd-blockquote omd-blockquote-1 omd-quote-in-li" style="--omd-list-depth:2">
         <div class="omd-code-header omd-blockquote omd-blockquote-1 omd-quote-in-li"></div>
       </div>`,
      ".omd-code-header",
    )
    expect(header.getPropertyValue("--omd-bq-bar").trim()).toBe("0px")
    expect(header.textIndent).toBe("0px")
  })
})
