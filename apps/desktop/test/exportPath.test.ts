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
})
