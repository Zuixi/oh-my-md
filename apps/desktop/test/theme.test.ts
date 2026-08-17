import { describe, expect, it } from "vitest"
import { applyTheme, toggleTheme } from "../src/theme"

describe("theme", () => {
  it("toggles light and dark", () => {
    expect(toggleTheme("light")).toBe("dark")
    expect(toggleTheme("dark")).toBe("light")
  })

  it("applies the theme dataset and injects custom CSS", () => {
    applyTheme("dark", ".omd-link { color: red; }")
    expect(document.documentElement.dataset.theme).toBe("dark")
    expect(document.getElementById("omd-user-theme")?.textContent).toBe(".omd-link { color: red; }")
  })
})
