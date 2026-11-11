import { describe, expect, it, vi, beforeEach } from "vitest"
import type { EditorView } from "@codemirror/view"
import { exportRichHtml } from "@omd/engine"
import { t } from "../src/i18n"
import { exportCurrent, type ExportRenderOptions } from "../src/appExportActions"
import type { DesktopServices } from "../src/desktopServices"
import { ExportImageError, type ExportImageErrorCode } from "../src/exportImages"

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

const RICH_EXPORT_HTML =
  '<!doctype html><html><body>rich<script>window.__omdExportReady=true</script></body></html>'

function mockReportedRemoteImage(src: string): void {
  vi.mocked(exportRichHtml).mockImplementationOnce(async (_state, options) => {
    options?.onRemoteImage?.(src)
    return RICH_EXPORT_HTML
  })
}

function makeView(doc = ""): EditorView {
  return { state: { doc: { toString: () => doc } } } as unknown as EditorView
}

/** Services whose progress/success/error channels append to one timeline. */
function trackedServices(overrides: Partial<DesktopServices> = {}) {
  const order: string[] = []
  const stop = vi.fn(() => { order.push("stop-progress") })
  const services = makeServices({
    notifyProgress: vi.fn((message: string) => {
      order.push(`progress:${message}`)
      return stop
    }),
    notifySuccess: vi.fn(() => { order.push("success") }),
    reportError: vi.fn(() => { order.push("error") }),
    ...overrides,
  })
  return { services, order, stop }
}

function renderOptions(sourcePath?: string | null): ExportRenderOptions {
  return { width: 800, scale: 2, theme: "light", sourcePath }
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

  it("shows a warning toast, not an error, when the file was written", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
      notifyWarning: vi.fn(),
      exportPreview: vi.fn().mockResolvedValue({
        code: "partial-render",
        detail: "Export completed with partial render; some content may be missing",
      }),
    })
    await exportCurrent(services, makeView(), "pdf")
    expect(vi.mocked(services.notifyWarning as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      t("export.warning.partialRender"),
    )
    expect(services.reportError).not.toHaveBeenCalled()
  })

  it("passes the configured scale and width to exportPreview", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.png"),
    })
    await exportCurrent(services, makeView(), "png", {}, undefined, undefined, {
      width: 1920,
      scale: 3,
      theme: "dark",
    })
    expect(vi.mocked(services.exportPreview as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.any(String),
      "/out/doc.png",
      "png",
      3,
      1920,
    )
    expect(vi.mocked(exportRichHtml)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ theme: "dark", fullWidth: true }),
    )
  })

it("threads customCss into exportRichHtml options", async () => {
    const services = makeServices()
    await exportCurrent(services, makeView(), "html", {}, ".foo{color:red}")
    expect(vi.mocked(exportRichHtml)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customCss: ".foo{color:red}", fullWidth: false }),
    )
  })

  it("passes undefined customCss when not provided", async () => {
    const services = makeServices()
    await exportCurrent(services, makeView(), "html")
    const options = vi.mocked(exportRichHtml).mock.calls[0]?.[1]
    expect(options?.customCss).toBeUndefined()
  })

  it("notices a remote-image warning when exporting PDF with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
    })
    const onNotice = vi.fn()
    mockReportedRemoteImage("https://example.com/x.png")
    await exportCurrent(services, makeView("![](https://example.com/x.png)"), "pdf", {}, undefined, onNotice)
    expect(onNotice).toHaveBeenCalledWith(t("export.remoteImageWarning"))
  })

  it("does not notice for PDF when only local images are present", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("![](assets/x.png)"), "pdf", {}, undefined, onNotice)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("notices a remote-image warning when exporting PNG with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.png"),
    })
    const onNotice = vi.fn()
    mockReportedRemoteImage("http://example.com/y.png")
    await exportCurrent(services, makeView("text ![](http://example.com/y.png) end"), "png", {}, undefined, onNotice)
    expect(onNotice).toHaveBeenCalledWith(t("export.remoteImageWarning"))
  })

  it("does not notice for HTML export even with a remote image", async () => {
    const services = makeServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.html"),
    })
    const onNotice = vi.fn()
    await exportCurrent(services, makeView("![](https://example.com/x.png)"), "html", {}, undefined, onNotice)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("shows progress while exporting and stops it before the success toast", async () => {
    const { services, order, stop } = trackedServices()
    vi.mocked(exportRichHtml).mockImplementationOnce(async () => {
      order.push("render")
      return "<!doctype html><html><body>rich</body></html>"
    })
    await exportCurrent(services, makeView(), "html")
    expect(services.notifyProgress).toHaveBeenCalledWith(t("export.progress"))
    expect(stop).toHaveBeenCalledOnce()
    expect(order).toEqual([
      `progress:${t("export.progress")}`,
      "render",
      "stop-progress",
      "success",
    ])
  })

  it("stops progress before reporting a render warning", async () => {
    const { services, order, stop } = trackedServices({
      pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
      exportPreview: vi.fn().mockResolvedValue({ code: "partial-render" }),
    })
    await exportCurrent(services, makeView(), "pdf")
    expect(stop).toHaveBeenCalledOnce()
    expect(order).toEqual([
      `progress:${t("export.progress")}`,
      "stop-progress",
      "error",
    ])
  })

  it("stops progress and reports a generic failure when the export throws", async () => {
    vi.mocked(exportRichHtml).mockRejectedValueOnce(new Error("boom"))
    const { services, order, stop } = trackedServices()
    await exportCurrent(services, makeView(), "html")
    expect(stop).toHaveBeenCalledOnce()
    expect(order).toEqual([
      `progress:${t("export.progress")}`,
      "stop-progress",
      "error",
    ])
    expect(services.reportError).toHaveBeenCalledWith(`${t("error.export.failed")}: boom`)
  })

  it("stops progress when the save dialog is cancelled", async () => {
    const { services, order, stop } = trackedServices({
      pickExportPath: vi.fn().mockResolvedValue(null),
    })
    await exportCurrent(services, makeView(), "html")
    expect(stop).toHaveBeenCalledOnce()
    expect(order).toEqual([`progress:${t("export.progress")}`, "stop-progress"])
    expect(services.writeFile).not.toHaveBeenCalled()
  })

  it("rejects a concurrent export while one is running", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const firstServices = makeServices({
      writeFile: vi.fn(async () => { await gate }),
    })
    const first = exportCurrent(firstServices, makeView(), "html")

    const secondServices = makeServices()
    const onNotice = vi.fn()
    await exportCurrent(secondServices, makeView(), "html", {}, undefined, onNotice)
    expect(onNotice).toHaveBeenCalledWith(t("export.busy"))
    expect(secondServices.pickExportPath).not.toHaveBeenCalled()
    expect(secondServices.reportError).not.toHaveBeenCalled()

    release()
    await first

    const laterServices = makeServices()
    await exportCurrent(laterServices, makeView(), "html")
    expect(laterServices.pickExportPath).toHaveBeenCalledWith("html")
    expect(laterServices.writeFile).toHaveBeenCalledWith("/out/doc.html", expect.any(String))
  })

  it("reports the busy message through reportError when no notice channel exists", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = exportCurrent(
      makeServices({ writeFile: vi.fn(async () => { await gate }) }),
      makeView(),
      "html",
    )
    const secondServices = makeServices()
    await exportCurrent(secondServices, makeView(), "html")
    expect(secondServices.reportError).toHaveBeenCalledWith(t("export.busy"))
    expect(secondServices.pickExportPath).not.toHaveBeenCalled()
    release()
    await first
  })

  it("resets the busy guard after a failed export", async () => {
    vi.mocked(exportRichHtml).mockRejectedValueOnce(new Error("boom"))
    const services = makeServices()
    await exportCurrent(services, makeView(), "html")
    await exportCurrent(services, makeView(), "html")
    expect(services.writeFile).toHaveBeenCalledOnce()
  })

  it("passes the active document path to the save dialog", async () => {
    const services = makeServices()
    await exportCurrent(services, makeView(), "png", {}, undefined, undefined, renderOptions("/docs/note.md"))
    expect(services.pickExportPath).toHaveBeenCalledWith("png", "/docs/note.md")
  })

  it("omits the source path for an unsaved document", async () => {
    const services = makeServices()
    await exportCurrent(services, makeView(), "html", {}, undefined, undefined, renderOptions(null))
    expect(services.pickExportPath).toHaveBeenCalledWith("html")
  })

  it("reports a localized message for each tagged image failure", async () => {
    const cases: Array<[ExportImageErrorCode, string, string]> = [
      ["no-document-path", "assets/a.png", t("export.error.unsavedImages")],
      ["read-failed", "assets/missing.png", t("export.error.imageRead", { src: "assets/missing.png" })],
      ["not-image", "assets/doc.txt", t("export.error.imageUnsupported", { src: "assets/doc.txt" })],
      ["too-large", "assets/huge.png", t("export.error.imageTooLarge", { src: "assets/huge.png" })],
      ["total-too-large", "assets/c.png", t("export.error.imagesTotalTooLarge")],
      ["timeout", "assets/hang.png", t("export.error.imageTimeout", { src: "assets/hang.png" })],
    ]
    for (const [code, src, expected] of cases) {
      vi.mocked(exportRichHtml).mockRejectedValueOnce(new ExportImageError(code, src))
      const services = makeServices({
        pickExportPath: vi.fn().mockResolvedValue("/out/doc.pdf"),
      })
      await exportCurrent(services, makeView(), "pdf")
      expect(services.reportError).toHaveBeenCalledWith(expected)
    }
  })
})
