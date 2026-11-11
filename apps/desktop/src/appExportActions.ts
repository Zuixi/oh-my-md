import { exportRichHtml, type ExportRichHtmlOptions } from "@omd/engine"
import type { EditorView } from "@codemirror/view"
import { errorMessage, type DesktopServices, type ExportWarning } from "./desktopServices"
import { ExportImageError } from "./exportImages"
import { t } from "./i18n"
import { baseName } from "./workspace"

export interface ExportRenderOptions {
  width: number
  scale: number
  theme: "light" | "dark"
  /** Saved document path; the save dialog suggests a sibling file from it. */
  sourcePath?: string | null
}

const DEFAULT_RENDER_OPTIONS: ExportRenderOptions = { width: 800, scale: 2, theme: "light" }

export type ExportOptionsSource =
  | ExportRichHtmlOptions
  | ((signal: AbortSignal) => ExportRichHtmlOptions)

let requestCounter = 0
function nextRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `export-${Date.now()}-${++requestCounter}`
}

/**
 * One export at a time per webview: a native PNG/PDF render can take seconds,
 * and a second trigger would race the same capture surface. Module scope is
 * correct because each editor window owns its own JS context.
 */
let exportInFlight = false

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
  exportOptions: ExportOptionsSource = {},
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
  const requestId = nextRequestId()
  const controller = new AbortController()
  let nativeStarted = false
  let cancelRequested = false
  let stopProgress: (() => void) | undefined
  let progressStopped = false
  /** Stop the loading toast before any terminal toast so the two do not race. */
  const finishProgress = (): void => {
    if (progressStopped) return
    progressStopped = true
    stopProgress?.()
  }
  const cancel = (): void => {
    if (cancelRequested) return
    cancelRequested = true
    controller.abort()
    // Only native rendering has backend state to cancel; preparation is
    // interrupted through the abort signal passed to the image resolver.
    if (nativeStarted) void services.cancelExport?.(requestId).catch(() => {})
  }
  const announceCancelled = (): void => {
    finishProgress()
    onNotice?.(t("export.cancelled"))
  }
  const cancelled = (): boolean => controller.signal.aborted
  try {
    if (kind !== "html" && !services.exportPreview) {
      throw new Error(t("error.export.desktopOnly"))
    }
    const format = kind === "html" ? "html" : kind === "pdf" ? "pdf" : "png"
    // Open the native Save dialog first so clicking "Export Image / PDF / HTML"
    // responds instantaneously instead of freezing the UI while rendering
    // syntax trees, KaTeX fonts, Shiki grammars, and local images.
    const path = await requestExportPath(services, format, renderOptions.sourcePath)
    if (cancelled()) {
      announceCancelled()
      return
    }
    if (!path) return
    stopProgress = services.notifyProgress?.(t("export.progress"), cancel)
    // Yield a macrotask after mounting the progress toast so the browser paints
    // the closed menu and progress indicator before CPU-heavy HTML generation.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (cancelled()) {
      announceCancelled()
      return
    }
    const wantsRemoteWarning = kind === "pdf" || kind === "png"
    let sawRemoteImage = false
    const resolvedOptions = typeof exportOptions === "function"
      ? exportOptions(controller.signal)
      : exportOptions
    const html = await exportRichHtml(view.state, {
      ...resolvedOptions,
      customCss,
      theme: renderOptions.theme,
      fullWidth: kind !== "html",
      onRemoteImage: wantsRemoteWarning
        ? () => { sawRemoteImage = true }
        : undefined,
    })
    if (cancelled()) {
      announceCancelled()
      return
    }
    // The engine reports remote images while rendering, so reference-style and
    // table-cell images warn too; a regex over the raw document missed both.
    if (sawRemoteImage) onNotice?.(t("export.remoteImageWarning"))
    if (kind === "html") {
      await services.writeFile(path, html)
      finishProgress()
      services.notifySuccess?.(t("notify.exportCompleted", { name: baseName(path) }))
      return
    }
    nativeStarted = true
    const previewFormat = kind === "pdf" ? "pdf" : "png"
    const warning = await services.exportPreview!(
      html,
      path,
      previewFormat,
      renderOptions.scale,
      renderOptions.width,
      requestId,
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
  } catch (error) {
    if (cancelRequested || controller.signal.aborted) {
      announceCancelled()
      return
    }
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
      case "timeout":
        return t("export.error.imageTimeout", { src: error.src })
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
