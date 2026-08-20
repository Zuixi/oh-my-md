import { exportRichHtml, type ExportRichHtmlOptions } from "@omd/engine"
import type { EditorView } from "@codemirror/view"
import { errorMessage, type DesktopServices } from "./desktopServices"
import { t } from "./i18n"
import { baseName } from "./workspace"

const REMOTE_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/

export function hasRemoteImages(doc: string): boolean {
  return REMOTE_IMAGE_RE.test(doc)
}

export async function exportCurrent(
  services: DesktopServices,
  view: EditorView | null,
  kind: "html" | "pdf" | "png",
  exportOptions: ExportRichHtmlOptions = {},
customCss?: string,
  onNotice?: (message: string) => void,
): Promise<void> {
  if (!view) return
  try {
    if ((kind === "pdf" || kind === "png") && hasRemoteImages(view.state.doc.toString())) {
      onNotice?.(t("export.remoteImageWarning"))
    }
    const html = await exportRichHtml(view.state, { ...exportOptions, customCss })
    if (kind === "html") {
      const path = await services.pickExportPath?.("html")
      if (path) {
        await services.writeFile(path, html)
        services.notifySuccess?.(t("notify.exportCompleted", { name: baseName(path) }))
      }
      return
    }
    if (!services.exportPreview) {
      throw new Error(t("error.export.desktopOnly"))
    }
    const format = kind === "pdf" ? "pdf" : "png"
    const path = await services.pickExportPath?.(format)
    if (path) {
      const warning = await services.exportPreview(html, path, format)
      if (warning) services.reportError(t("error.export.warning", { detail: warning }))
      else services.notifySuccess?.(t("notify.exportCompleted", { name: baseName(path) }))
    }
  } catch (error) {
    services.reportError(errorMessage(t("error.export.failed"), error))
  }
}

export async function loadCustomCss(
  services: DesktopServices,
  setCustomCss: (css: string) => void,
): Promise<void> {
  try {
    const path = await services.pickCssPath?.()
    if (!path) return
    setCustomCss(await services.readFile(path))
  } catch (error) {
    setCustomCss("")
    services.reportError(errorMessage(t("error.css.failed"), error))
  }
}
