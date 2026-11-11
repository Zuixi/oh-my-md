import { baseName, childPath, parentDir, plainPath } from "./workspace"

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
  // Rust file commands may return Windows verbatim paths (`\\?\C:\...`);
  // the save dialog wants the user-facing form, not the native prefix.
  const source = plainPath(sourcePath)
  const dir = parentDir(source)
  const name = baseName(source)
  // `baseName` echoes the whole path for a trailing separator; that is a
  // directory, not a document with a reusable stem.
  if (dir === null || !name || name === source) return `export.${format}`
  // Strip only the final extension: `notes.v2.md` keeps `notes.v2`.
  const extensionAt = name.lastIndexOf(".")
  const stem = extensionAt >= 0 ? name.slice(0, extensionAt) : name
  if (!stem) return `export.${format}`
  return childPath(dir, `${stem}.${format}`)
}
