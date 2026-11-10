import { baseName, childPath, parentDir } from "./workspace"

export type ExportFormat = "html" | "pdf" | "png"

/**
 * Save-dialog defaults. A saved document exports next to itself with its own
 * stem (`/docs/note.md` → `/docs/note.png`) so the dialog opens where the user
 * expects; a draft has no stem to borrow and falls back to the generic name.
 * `baseName`/`parentDir`/`childPath` keep the source path's own separator
 * form, so a Windows `C:\docs\note.md` stays native.
 */
export function exportSaveOptions(format: ExportFormat, sourcePath?: string | null) {
  return {
    defaultPath: defaultExportPath(format, sourcePath),
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  }
}

function defaultExportPath(format: ExportFormat, sourcePath?: string | null): string {
  if (!sourcePath) return `export.${format}`
  const dir = parentDir(sourcePath)
  const name = baseName(sourcePath)
  // `baseName` echoes the whole path for a trailing separator; that is a
  // directory, not a document with a reusable stem.
  if (dir === null || !name || name === sourcePath) return `export.${format}`
  // Strip only the final extension: `notes.v2.md` keeps `notes.v2`.
  const extensionAt = name.lastIndexOf(".")
  const stem = extensionAt >= 0 ? name.slice(0, extensionAt) : name
  if (!stem) return `export.${format}`
  return childPath(dir, `${stem}.${format}`)
}
