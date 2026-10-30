import { describe, expect, it } from "vitest"
import { normalizePasteUrl } from "../src/paste/urlPolicy"

// URL policy contract (plan 02 Task 2): one gate for Link and Image hrefs.
// Permitted `data:image/*` extraction happens before this function, so every
// `data:` string reaching the policy is rejected.

describe("normalizePasteUrl — accepted link URLs", () => {
  it("keeps http and https, including mixed-case schemes", () => {
    expect(normalizePasteUrl("https://example.com/a?b=1#c", "link")).toBe("https://example.com/a?b=1#c")
    expect(normalizePasteUrl("http://example.com/", "link")).toBe("http://example.com/")
    expect(normalizePasteUrl("HTTPS://Example.com/Path", "link")).toBe("HTTPS://Example.com/Path")
    expect(normalizePasteUrl("hTtP://example.com/x", "link")).toBe("hTtP://example.com/x")
  })

  it("keeps mailto links", () => {
    expect(normalizePasteUrl("mailto:me@example.com", "link")).toBe("mailto:me@example.com")
    expect(normalizePasteUrl("MAILTO:me@example.com?subject=hi", "link")).toBe("MAILTO:me@example.com?subject=hi")
  })

  it("keeps fragments", () => {
    expect(normalizePasteUrl("#section-2", "link")).toBe("#section-2")
    expect(normalizePasteUrl("#", "link")).toBe("#")
  })

  it("keeps protocol-relative URLs", () => {
    expect(normalizePasteUrl("//cdn.example.com/a.png", "link")).toBe("//cdn.example.com/a.png")
  })

  it("keeps relative, absolute-path and dotted Markdown paths", () => {
    expect(normalizePasteUrl("notes/other.md", "link")).toBe("notes/other.md")
    expect(normalizePasteUrl("./a.md", "link")).toBe("./a.md")
    expect(normalizePasteUrl("../up/a.md", "link")).toBe("../up/a.md")
    expect(normalizePasteUrl("/root/a.md", "link")).toBe("/root/a.md")
    expect(normalizePasteUrl("my file.md", "link")).toBe("my file.md")
  })

  it("keeps percent-encoded and safe entity-normalized forms", () => {
    expect(normalizePasteUrl("https://example.com/a%20b?q=%E4%B8%AD", "link")).toBe(
      "https://example.com/a%20b?q=%E4%B8%AD",
    )
    expect(normalizePasteUrl("&#104;ttps://example.com/x", "link")).toBe("https://example.com/x")
    expect(normalizePasteUrl("https&#58;//example.com/x", "link")).toBe("https://example.com/x")
  })

  it("trims HTML/ASCII whitespace", () => {
    expect(normalizePasteUrl("  https://example.com/a  ", "link")).toBe("https://example.com/a")
    expect(normalizePasteUrl("\t\nhttps://example.com/a\r\n", "link")).toBe("https://example.com/a")
  })
})

describe("normalizePasteUrl — accepted image URLs", () => {
  it("keeps relative, http/https and protocol-relative sources", () => {
    expect(normalizePasteUrl("assets/a.png", "image")).toBe("assets/a.png")
    expect(normalizePasteUrl("./a.png", "image")).toBe("./a.png")
    expect(normalizePasteUrl("../a.png", "image")).toBe("../a.png")
    expect(normalizePasteUrl("/a.png", "image")).toBe("/a.png")
    expect(normalizePasteUrl("https://example.com/a.png", "image")).toBe("https://example.com/a.png")
    expect(normalizePasteUrl("HTTP://example.com/a.png", "image")).toBe("HTTP://example.com/a.png")
    expect(normalizePasteUrl("//cdn.example.com/a.png", "image")).toBe("//cdn.example.com/a.png")
  })
})

describe("normalizePasteUrl — rejected schemes", () => {
  it("rejects javascript, vbscript, file, blob and unknown schemes", () => {
    expect(normalizePasteUrl("javascript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("JavaScript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("vbscript:msgbox(1)", "link")).toBeNull()
    expect(normalizePasteUrl("file:///etc/passwd", "link")).toBeNull()
    expect(normalizePasteUrl("file:///etc/passwd", "image")).toBeNull()
    expect(normalizePasteUrl("blob:https://example.com/x", "image")).toBeNull()
    expect(normalizePasteUrl("ftp://example.com/a.png", "image")).toBeNull()
    expect(normalizePasteUrl("custom-scheme://x/y", "link")).toBeNull()
    expect(normalizePasteUrl("chrome://settings", "link")).toBeNull()
  })

  it("rejects every data URL, including data:image/*", () => {
    for (const kind of ["link", "image"] as const) {
      expect(normalizePasteUrl("data:text/html;base64,PHNjcmlwdD4=", kind)).toBeNull()
      expect(normalizePasteUrl("data:text/html,<b>x</b>", kind)).toBeNull()
      expect(normalizePasteUrl("DATA:image/png;base64,iVBORw0KGgo=", kind)).toBeNull()
      expect(normalizePasteUrl("data:image/svg+xml;base64,PHN2Zz4=", kind)).toBeNull()
      expect(normalizePasteUrl("data:", kind)).toBeNull()
    }
  })

  it("rejects mailto and fragments for images", () => {
    expect(normalizePasteUrl("mailto:me@example.com", "image")).toBeNull()
    expect(normalizePasteUrl("#frag", "image")).toBeNull()
  })

  it("rejects empty and whitespace-only values", () => {
    for (const kind of ["link", "image"] as const) {
      expect(normalizePasteUrl("", kind)).toBeNull()
      expect(normalizePasteUrl("   \t\n", kind)).toBeNull()
      expect(normalizePasteUrl("\u0000", kind)).toBeNull()
    }
  })
})

describe("normalizePasteUrl — obfuscated and ambiguous values", () => {
  it("rejects control-character-obfuscated schemes", () => {
    expect(normalizePasteUrl("java\tscript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("java\nscript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("java\rscript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("java\u0000script:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("java\u0001script:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("\u0000javascript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("\u001Fdata:text/html,x", "link")).toBeNull()
  })

  it("never repairs a split scheme into an allowed one", () => {
    expect(normalizePasteUrl("ht\ntp://example.com/a", "link")).toBeNull()
    expect(normalizePasteUrl("h\tttps://example.com/a", "link")).toBeNull()
    expect(normalizePasteUrl("mail\u0000to:me@example.com", "link")).toBeNull()
  })

  it("rejects entity- and percent-encoded dangerous schemes", () => {
    expect(normalizePasteUrl("jav&#x61;script:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("javascript&colon;alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("&#106;avascript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("vb&#115;cript:msgbox(1)", "link")).toBeNull()
    expect(normalizePasteUrl("%6aavascript:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("%64ata:text/html,x", "link")).toBeNull()
  })

  it("rejects a scheme-shaped prefix that is not a valid scheme", () => {
    expect(normalizePasteUrl("java script:alert(1)", "link")).toBeNull()
    expect(normalizePasteUrl("-bad:thing", "link")).toBeNull()
  })

  it("strips control characters outside the scheme before returning", () => {
    expect(normalizePasteUrl("https://example.com/a\u0000b", "link")).toBe("https://example.com/ab")
    expect(normalizePasteUrl("https://example.com/a\nb", "link")).toBe("https://example.com/ab")
  })
})
