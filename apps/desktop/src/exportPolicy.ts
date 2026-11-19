import { DEFAULT_PRINT_SETUP, type PrintSetup } from "@omd/engine"
import type { UserSettings } from "./settings"
import { baseName } from "./workspace"

/** PDF is printed, so it always uses the light theme. HTML and PNG keep the editor theme. */
export function resolveExportTheme(
  kind: "html" | "pdf" | "png",
  theme: "light" | "dark",
): "light" | "dark" {
  return kind === "pdf" ? "light" : theme
}

/** Title for the native PDF header. The directory is never included. */
export function documentTitle(sourcePath?: string | null): string {
  if (!sourcePath) return "oh-my-md"
  const stem = baseName(sourcePath).replace(/\.(markdown|md|txt)$/i, "")
  const cleaned = [...stem]
    .map(char => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
  return cleaned || "oh-my-md"
}

export function pageSetupFromSettings(
  settings: UserSettings,
  sourcePath?: string | null,
): PrintSetup {
  return {
    paper: settings.exportPaper,
    orientation: settings.exportOrientation,
    headingPageBreak: settings.exportHeadingPageBreak,
    marginTopMm: settings.exportMarginTopMm,
    marginRightMm: settings.exportMarginRightMm,
    marginBottomMm: settings.exportMarginBottomMm,
    marginLeftMm: settings.exportMarginLeftMm,
    printBackgrounds: DEFAULT_PRINT_SETUP.printBackgrounds,
    headerFooter: settings.exportHeaderFooter,
    headerTitle: documentTitle(sourcePath),
  }
}
