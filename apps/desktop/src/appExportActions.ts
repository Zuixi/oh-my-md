import { exportRichHtml, type ExportRichHtmlOptions } from "@omd/engine"
import type { EditorView } from "@codemirror/view"
import { errorMessage, type DesktopServices, type ExportWarning } from "./desktopServices"
import { ExportImageError } from "./exportImages"
import { t } from "./i18n"
import { baseName } from "./workspace"

const REMOTE_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/

export interface ExportRenderOptions {
  width: number
  scale: number
  theme: "light" | "dark"
  /** Saved document path; the save dialog suggests a sibling file from it. */
  sourcePath?: string | null
}

const DEFAULT_RENDER_OPTIONS: ExportRenderOptions = { width: 800, scale: 2, theme: "light" }

/**
 * One export at a time per webview: a native PNG/PDF render can take seconds,
 * and a second trigger would race the same capture surface. Module scope is
 * correct because each editor window owns its own JS context.
 */
let exportInFlight = false

export function hasRemoteImages(doc: string): boolean {
  return REMOTE_IMAGE_RE.test(doc)
}

function warningMessage(warning: ExportWarning): string {
  if (warning.code === "height-clamped") {
    return t("export.warning.heightClamped")
  }
  if (warning.code === "partial-render") {
    return t("export.warning.partialRender")
  }
  return t("error.export.warning", { detail: warning.detail ?? warning.code })
}

export async function exportCurrent(
  services: DesktopServices,
  view: EditorView | null,
  kind: "html" | "pdf" | "png",
  exportOptions: ExportRichHtmlOptions = {},
  customCss?: string,
  onNotice?: (message: string) => void,
  renderOptions: ExportRenderOptions = DEFAULT_RENDER_OPTIONS,
): Promise<void> {
  if (!view) return
  if (exportInFlight) {
    const message = t("export.busy")
    if (onNotice) onNotice(message)
    else services.reportError(message)
    return
  }
  exportInFlight = true
  let stopProgress: (() => void) | undefined
  let progressStopped = false
  /** Stop the loading toast before any terminal toast so the two do not race. */
  const finishProgress = (): void => {
    if (progressStopped) return
    progressStopped = true
    stopProgress?.()
  }
  try {
    stopProgress = services.notifyProgress?.(t("export.progress"))
    if ((kind === "pdf" || kind === "png") && hasRemoteImages(view.state.doc.toString())) {
      onNotice?.(t("export.remoteImageWarning"))
    }
    const html = await exportRichHtml(view.state, {
      ...exportOptions,
      customCss,
      theme: renderOptions.theme,
      fullWidth: kind !== "html",
    })
    if (kind === "html") {
      const path = await requestExportPath(services, "html", renderOptions.sourcePath)
      if (path) {
        await services.writeFile(path, html)
        finishProgress()
        services.notifySuccess?.(t("notify.exportCompleted", { name: baseName(path) }))
      }
      return
    }
    if (!services.exportPreview) {
      throw new Error(t("error.export.desktopOnly"))
    }
    const format = kind === "pdf" ? "pdf" : "png"
    const path = await requestExportPath(services, format, renderOptions.sourcePath)
    if (path) {
      const warning = await services.exportPreview(
        html,
        path,
        format,
        renderOptions.scale,
        renderOptions.width,
      )
      finishProgress()
      if (warning) {
        // The file was written successfully; a warning must not look like a
        // failed export. Fall back to the error channel only for test doubles
        // and browser builds that omit the warning toast.
        const reportWarning = services.notifyWarning ?? services.reportError
        reportWarning(warningMessage(warning))
      } else {
        services.notifySuccess?.(t("notify.exportCompleted", { name: baseName(path) }))
      }
    }
  } catch (error) {
    finishProgress()
    services.reportError(exportFailureMessage(error))
  } finally {
    finishProgress()
    exportInFlight = false
  }
}

/**
 * Omit the source argument when the draft is unsaved: the dialog then uses its
 * generic default, and the optional second parameter keeps single-argument
 * call sites source-compatible.
 */
function requestExportPath(
  services: DesktopServices,
  format: "html" | "pdf" | "png",
  sourcePath?: string | null,
): Promise<string | null> | undefined {
  return sourcePath
    ? services.pickExportPath?.(format, sourcePath)
    : services.pickExportPath?.(format)
}

/** Image failures carry an actionable, localized line; everything else keeps the generic wrapper. */
function exportFailureMessage(error: unknown): string {
  if (error instanceof ExportImageError) {
    switch (error.code) {
      case "no-document-path":
        return t("export.error.unsavedImages")
      case "read-failed":
        return t("export.error.imageRead", { src: error.src })
      case "not-image":
        return t("export.error.imageUnsupported", { src: error.src })
      case "too-large":
        return t("export.error.imageTooLarge", { src: error.src })
      case "total-too-large":
        return t("export.error.imagesTotalTooLarge")
    }
  }
  return errorMessage(t("error.export.failed"), error)
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
