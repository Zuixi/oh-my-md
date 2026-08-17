export type ExportFormat = "html" | "pdf" | "png"

export function exportSaveOptions(format: ExportFormat) {
  return {
    defaultPath: `export.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  }
}
