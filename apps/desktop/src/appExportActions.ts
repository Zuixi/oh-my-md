import { exportHtml } from "@omd/engine"
import type { EditorView } from "@codemirror/view"
import { errorMessage, type DesktopServices } from "./desktopServices"

export async function exportCurrent(
  services: DesktopServices,
  view: EditorView | null,
  kind: "html" | "pdf" | "png",
): Promise<void> {
  if (!view) return
  try {
    const html = exportHtml(view.state)
    if (kind === "html") {
      const path = await services.pickExportPath?.("html")
      if (path) await services.writeFile(path, html)
      return
    }
    if (!services.exportPreview) {
      throw new Error("PDF and image export are only available in the desktop app")
    }
    const format = kind === "pdf" ? "pdf" : "png"
    const path = await services.pickExportPath?.(format)
    if (path) await services.exportPreview(html, path, format)
  } catch (error) {
    services.reportError(errorMessage("Export failed", error))
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
    services.reportError(errorMessage("Custom CSS failed", error))
  }
}
