import { describe, expect, it, vi, beforeEach } from "vitest"
import type { EditorView } from "@codemirror/view"
import { exportRichHtml } from "@omd/engine"
import { t } from "../src/i18n"
import { exportCurrent } from "../src/appExportActions"
import type { DesktopServices } from "../src/desktopServices"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportRichHtml: vi.fn().mockResolvedValue("<!doctype html><html><head></head><body>rich<script>window.__omdExportReady=true</script></body></html>"),
  }
})

function makeServices(overrides: Partial<DesktopServices> = {}): DesktopServices {
  return {
    reportError: vi.fn(),
    pickExportPath: vi.fn().mockResolvedValue("/out/doc.html"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    exportPreview: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as DesktopServices
}

function makeView(doc = ""): EditorView {
  return { state: { doc: { toString: () => doc } } } as unknown as EditorView
}

describe("exportCurrent", () => {
  beforeEach(() => {
    vi.mocked(exportRichHtml).mockClear()
  })

  it("calls exportRichHtml (async) instead of exportHtml for HTML export", async () => {
    const services = makeServices()
    await exportCurrent(services, makeView(), "html")
    expect(vi.mocked(exportRichHtml)).toHaveBeenCalledOnce()
    expect(vi.mocked(services.writeFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "/out/doc.html",
      expect.stringContaining("rich"),
    )
  })

  it("awaits exportRichHtml before calling exportPreview for PDF export", async () => {
    const order: string[] = []
    vi.mocked(exportRichHtml).mockImplementation(async () => {
      order.push("exportRichHtml")
      return "<!doctype html><html><body>rich</body></html>"
    })
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
      exportPreview: vi.fn().mockImplementation(async () => { order.push("exportPreview") }),
    })
    await exportCurrent(services, makeView(), "pdf")
    expect(order).toEqual(["exportRichHtml", "exportPreview"])
  })

  it("does not call exportRichHtml when view is null", async () => {
    const services = makeServices()
    await exportCurrent(services, null, "html")
    expect(vi.mocked(exportRichHtml)).not.toHaveBeenCalled()
  })

  it("reports a warning when exportPreview signals render timeout", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
      exportPreview: vi.fn().mockResolvedValue("Export completed with partial render; some content may be missing"),
    })
    await exportCurrent(services, makeView(), "pdf")
    expect(vi.mocked(services.reportError as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining(t("error.export.warning", { detail: "" }).split(":")[0].trim()),
    )
  })

  it("notices a remote-image warning when exporting PDF with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("![](https://example.com/x.png)"), "pdf", {}, onNotice)
    expect(onNotice).toHaveBeenCalledWith(t("export.remoteImageWarning"))
  })

  it("does not notice for PDF when only local images are present", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("![](assets/x.png)"), "pdf", {}, onNotice)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("notices a remote-image warning when exporting PNG with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.png"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("text ![](http://example.com/y.png) end"), "png", {}, onNotice)
    expect(onNotice).toHaveBeenCalledWith(t("export.remoteImageWarning"))
  })

  it("does not notice for HTML export even with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.html"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("![](https://example.com/x.png)"), "html", {}, onNotice)
    expect(onNotice).not.toHaveBeenCalled()
  })
})
