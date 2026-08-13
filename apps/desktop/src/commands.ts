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

const MENU_TO_COMMAND: Readonly<Record<string, string>> = {
  new: "tab",
  "new-tab": "tab",
  "open-file": "open",
  "open-folder": "folder",
  close: "close",
  save: "save",
  "save-as": "save-as",
  "export-html": "export-html",
  "export-pdf": "export-pdf",
  "export-image": "export-image",
  "clear-recents": "clear-recents",
}

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
