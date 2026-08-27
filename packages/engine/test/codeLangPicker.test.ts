import { afterEach, describe, expect, it, vi } from "vitest"
import { createCodeLangPicker } from "../src/decorations/widgets/codeLangPicker"

const LANGS = ["bash", "c", "cpp", "javascript", "typescript"] as const

function mountPicker(overrides: Partial<Parameters<typeof createCodeLangPicker>[0]> = {}) {
  const onSelect = vi.fn()
  const { root } = createCodeLangPicker({
    value: "cpp",
    languages: LANGS,
    onSelect,
    ...overrides,
  })
  document.body.appendChild(root)
  return { root, onSelect }
}

describe("createCodeLangPicker", () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it("labels the trigger with the current language", () => {
    const { root } = mountPicker({ value: "javascript" })
    const trigger = root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement
    expect(trigger.textContent).toContain("javascript")
  })

  it("opens a downward popover with search and language rows", () => {
    const { root } = mountPicker()
    const trigger = root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement
    trigger.click()
    expect(root.querySelector(".omd-code-lang-popover")).toBeTruthy()
    expect(root.querySelector(".omd-code-lang-search")).toBeTruthy()
    expect(root.querySelectorAll(".omd-code-lang-row")).toHaveLength(LANGS.length)
  })

  it("filters languages from the search field", () => {
    const { root } = mountPicker()
    ;(root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement).click()
    const search = root.querySelector(".omd-code-lang-search") as HTMLInputElement
    search.value = "java"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    const rows = [...root.querySelectorAll(".omd-code-lang-row")]
    expect(rows.map(row => row.textContent?.trim())).toEqual(["javascript"])
  })

  it("commits a selection and closes the popover", () => {
    const { root, onSelect } = mountPicker()
    ;(root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement).click()
    const row = [...root.querySelectorAll(".omd-code-lang-row")]
      .find(el => el.textContent?.includes("bash")) as HTMLButtonElement
    row.click()
    expect(onSelect).toHaveBeenCalledWith("bash")
    expect(root.querySelector(".omd-code-lang-popover")).toBeNull()
  })

  it("closes the popover on an outside press", () => {
    const { root } = mountPicker()
    ;(root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement).click()
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(root.querySelector(".omd-code-lang-popover")).toBeNull()
  })

  it("disables the trigger when read-only", () => {
    const { root } = mountPicker({ disabled: true })
    const trigger = root.querySelector(".omd-code-lang-trigger") as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
  })
})
