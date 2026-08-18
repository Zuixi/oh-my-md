import { afterEach, describe, expect, it } from "vitest"
import { currentPlatform, formatBinding, isLinux, isMacOS, isWindows } from "../src/platform"

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
}

afterEach(() => setUserAgent(""))

describe("currentPlatform", () => {
  it("detects macOS WKWebView", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
    expect(currentPlatform()).toBe("macos")
  })
  it("detects Windows WebView2", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
    expect(currentPlatform()).toBe("windows")
  })
  it("detects Linux WebKitGTK", () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/4.0 Safari/605.1.15")
    expect(currentPlatform()).toBe("linux")
  })
  it("falls back to macos for unknown agents", () => {
    setUserAgent("")
    expect(currentPlatform()).toBe("macos")
    expect(isMacOS()).toBe(true)
    expect(isWindows()).toBe(false)
    expect(isLinux()).toBe(false)
  })
})

describe("formatBinding", () => {
  it("renders mac glyphs", () => {
    expect(formatBinding("Mod+s", "macos")).toBe("⌘S")
    expect(formatBinding("Mod+Shift+o", "macos")).toBe("⇧⌘O")
    expect(formatBinding("Mod-Alt-7", "macos")).toBe("⌥⌘7")
  })
  it("renders ctrl words on windows and linux", () => {
    expect(formatBinding("Mod+s", "windows")).toBe("Ctrl+S")
    expect(formatBinding("Mod+Shift+o", "linux")).toBe("Ctrl+Shift+O")
    expect(formatBinding("Mod-Alt-7", "windows")).toBe("Ctrl+Alt+7")
  })
})
