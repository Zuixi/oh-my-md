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
})
