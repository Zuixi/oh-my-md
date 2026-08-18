export interface AppCommand {
  id: string
  label: string
  shortcut?: string
  run: () => void
}

export function filterCommands(commands: AppCommand[], query: string): AppCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(command =>
    command.label.toLowerCase().includes(q) || command.id.toLowerCase().includes(q))
}

export interface MenuExtras {
  openRecent?: (path: string) => void
}

const RECENT_PREFIX = "recent:"

/** Native menu item id → command palette id. Kept in sync with `src-tauri/src/menu.rs`. */
export const MENU_TO_COMMAND: Readonly<Record<string, string>> = {
  new: "tab",
  "new-tab": "tab",
  "open-file": "open",
  "quick-open": "quick-open",
  "open-folder": "folder",
  close: "close",
  save: "save",
  "save-as": "save-as",
  "version-history": "history",
  "export-html": "export-html",
  "export-pdf": "export-pdf",
  "export-image": "export-image",
  "clear-recents": "clear-recents",
  preferences: "preferences",
  "check-updates": "check-updates",
  "export-diagnostics": "export-diagnostics",
  bold: "bold",
  italic: "italic",
  strikethrough: "strikethrough",
  "inline-code": "inline-code",
  "code-block": "code-block",
  "heading-1": "heading-1",
  "heading-2": "heading-2",
  "heading-3": "heading-3",
  "heading-4": "heading-4",
  "heading-5": "heading-5",
  "heading-6": "heading-6",
  "ordered-list": "ordered-list",
  "unordered-list": "unordered-list",
  blockquote: "blockquote",
  link: "link",
  "insert-image": "insert-image",
  "view-source": "source",
  "view-sidebar": "sidebar",
  "view-outline": "outline",
  "view-typewriter": "typewriter",
  "view-focus": "focus",
  "toggle-theme": "theme",
  "load-css": "css",
  find: "find",
  search: "search",
}

/**
 * Command ids whose export backends are native macOS WebView captures (spec D3).
 * Off macOS these commands are filtered from the palette and hidden from the
 * native menu (Task 10's AppMenu reuses this set).
 */
export const MACOS_ONLY_COMMANDS: ReadonlySet<string> = new Set(["export-pdf", "export-image"])

export function runMenuCommand(
  id: string,
  commands: AppCommand[],
  extras?: MenuExtras,
): void {
  if (id.startsWith(RECENT_PREFIX)) {
    const path = id.slice(RECENT_PREFIX.length)
    if (path) extras?.openRecent?.(path)
    return
  }
  const commandId = MENU_TO_COMMAND[id]
  if (!commandId) return
  commands.find(command => command.id === commandId)?.run()
}
