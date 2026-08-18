import { markdownShortcutLabels, toggleShortcutLabels } from "@omd/engine"

/**
 * Single source of truth for command shortcuts.
 *
 * - `WINDOW_SHORTCUTS` back both the palette display strings and the window
 *   keydown dispatch in `App.tsx`, so a new app-level shortcut is defined once.
 * - Format/mode shortcuts are owned by the engine keymap; the display labels
 *   are derived there (`markdownShortcutLabels` / `toggleShortcutLabels`) so the
 *   palette can never drift from the editor bindings.
 */

export interface WindowShortcut {
  /** AppCommand id this shortcut triggers. */
  id: string
  /** Palette display form, e.g. "⌘S". */
  keys: string
  /** KeyboardEvent.key to match (case-insensitive). */
  key: string
  shift?: boolean
}

export const WINDOW_SHORTCUTS: readonly WindowShortcut[] = [
  { id: "preferences", keys: "⌘,", key: "," },
  { id: "sidebar", keys: "⌘\\", key: "\\" },
  { id: "outline", keys: "⇧⌘O", key: "O", shift: true },
  { id: "search", keys: "⇧⌘F", key: "f", shift: true },
  { id: "find", keys: "⌘F", key: "f" },
  { id: "quick-open", keys: "⌘P", key: "p" },
  { id: "open", keys: "⌘O", key: "o" },
  { id: "tab", keys: "⌘N", key: "n" },
  { id: "close", keys: "⌘W", key: "w" },
  { id: "save", keys: "⌘S", key: "s" },
  { id: "save-as", keys: "⇧⌘S", key: "s", shift: true },
]

export const FORMAT_SHORTCUTS: Readonly<Record<string, string>> = {
  ...markdownShortcutLabels,
  ...toggleShortcutLabels,
}

export function shortcutFor(commandId: string): string | undefined {
  return WINDOW_SHORTCUTS.find(shortcut => shortcut.id === commandId)?.keys
    ?? FORMAT_SHORTCUTS[commandId]
}

/** Matches a window shortcut, mirroring the app-level (not editor) key handling. */
export function matchesWindowShortcut(
  binding: WindowShortcut,
  event: KeyboardEvent,
): boolean {
  return (
    event.key.toLowerCase() === binding.key.toLowerCase()
    && event.shiftKey === (binding.shift === true)
    && (event.metaKey || event.ctrlKey)
  )
}
