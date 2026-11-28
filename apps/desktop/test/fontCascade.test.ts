import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

function append(className: string, parent: HTMLElement, tagName = "span") {
  const element = document.createElement(tagName)
  element.className = className
  parent.appendChild(element)
  return element
}

describe("editor content font cascade", () => {
  afterEach(() => {
    document.head.querySelector("style[data-omd-styles-test]")?.remove()
    document.body.replaceChildren()
    document.documentElement.style.removeProperty("--omd-font-family")
    document.documentElement.style.removeProperty("--omd-font-size")
    document.documentElement.style.removeProperty("--omd-ui-font-family")
  })

  it("resolves the selected family on every code and math editing surface", () => {
    const style = document.createElement("style")
    style.dataset.omdStylesTest = "true"
    style.textContent = STYLES_CSS
    document.head.appendChild(style)
    document.documentElement.style.setProperty("--omd-font-family", '"Cascade Sentinel"')

    const host = append("editor-host", document.body, "div")
    const content = append("cm-content", host, "div")
    const inlineCode = append("omd-inline-code", content)
    const sourceCode = append("cm-line omd-codeblock", content, "div")
    const renderedCode = append("omd-code", content, "div")
    const pre = append("", renderedCode, "pre")
    const code = append("", pre, "code")
    const mathEditor = append("omd-math-editor", content, "textarea")

    for (const element of [inlineCode, sourceCode, pre, code, mathEditor]) {
      expect(getComputedStyle(element).fontFamily).toBe('"Cascade Sentinel"')
    }
  })

  it("keeps sidebar and status bar chrome on --omd-ui-font-family with unified sizes", () => {
    expect(STYLES_CSS).toMatch(/--omd-ui-font-family\s*:[^;]*sans-serif\s*;/)

    const style = document.createElement("style")
    style.dataset.omdStylesTest = "true"
    style.textContent = STYLES_CSS
    document.head.appendChild(style)
    document.documentElement.style.setProperty("--omd-ui-font-family", '"UI Chrome Sentinel"')
    document.documentElement.style.setProperty("--omd-font-family", '"Editor Only Serif"')
    document.documentElement.style.setProperty("--omd-font-size", "24px")

    const sidebarPrimary = append("sidebar-primary", document.body, "aside")
    const sidebarTitle = append("sidebar-title", sidebarPrimary, "div")
    const searchBtn = append("filetree-search-btn", sidebarPrimary, "button")
    const fileTreeItem = append("filetree-item", sidebarPrimary, "button")

    const sidebarSecondary = append("sidebar-secondary", document.body, "aside")
    const outlineItem = append("outline-item", sidebarSecondary, "button")

    const statusBar = append("statusbar", document.body, "div")
    const breadcrumb = append("statusbar-breadcrumb", statusBar, "button")
    const statusRight = append("statusbar-right", statusBar, "div")

    // happy-dom resolves `var(...)` on ancestors and preserves the literal
    // `inherit` keyword on form controls rather than flattening it to the
    // parent's computed value; checking both pins the cascade chain.
    for (const element of [document.body, sidebarTitle, statusBar]) {
      expect(getComputedStyle(element).fontFamily).toBe('"UI Chrome Sentinel"')
    }
    for (const control of [searchBtn, fileTreeItem, outlineItem, breadcrumb]) {
      expect(["inherit", '"UI Chrome Sentinel"']).toContain(getComputedStyle(control).fontFamily)
    }

    expect(getComputedStyle(fileTreeItem).fontSize).toBe("13px")
    expect(getComputedStyle(outlineItem).fontSize).toBe("13px")
    expect(getComputedStyle(statusBar).fontSize).toBe("12px")
    expect(["inherit", "12px"]).toContain(getComputedStyle(breadcrumb).fontSize)
    expect(getComputedStyle(statusRight).fontVariantNumeric).toBe("tabular-nums")
  })
})
