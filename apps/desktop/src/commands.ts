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

const MENU_TO_COMMAND: Readonly<Record<string, string>> = {
  "open-file": "open",
  "open-folder": "folder",
  save: "save",
  "new-tab": "tab",
  "export-html": "export-html",
  "export-pdf": "export-pdf",
}

export function runMenuCommand(id: string, commands: AppCommand[]): void {
  const commandId = MENU_TO_COMMAND[id]
  if (!commandId) return
  commands.find(command => command.id === commandId)?.run()
}
