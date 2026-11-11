import { describe, expect, it } from "vitest"
import { exportSaveOptions } from "../src/exportPath"

describe("export save dialog", () => {
  it("defaults image export to a .png filename so the save panel has an extension", () => {
    expect(exportSaveOptions("png")).toEqual({
      defaultPath: "export.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    })
  })

  it("defaults PDF export to a .pdf filename", () => {
    expect(exportSaveOptions("pdf").defaultPath).toBe("export.pdf")
  })

  it("suggests the document's stem next to the document", () => {
    expect(exportSaveOptions("png", "/docs/note.md").defaultPath).toBe("/docs/note.png")
  })

  it("keeps Windows separators in the suggested path", () => {
    expect(exportSaveOptions("pdf", "C:\\docs\\note.md")).toEqual({
      defaultPath: "C:\\docs\\note.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    })
  })

  it("strips a Windows verbatim prefix before suggesting a path", () => {
    expect(exportSaveOptions("png", String.raw`\\?\C:\docs\note.md`).defaultPath).toBe(
      "C:\\docs\\note.png",
    )
  })

  it("strips only the final extension", () => {
    expect(exportSaveOptions("png", "/docs/notes.v2.md").defaultPath).toBe(
      "/docs/notes.v2.png",
    )
  })

  it("falls back to the generic name for a draft or empty path", () => {
    expect(exportSaveOptions("png", null).defaultPath).toBe("export.png")
    expect(exportSaveOptions("png", "").defaultPath).toBe("export.png")
    expect(exportSaveOptions("html", "note.md").defaultPath).toBe("export.html")
  })
})
