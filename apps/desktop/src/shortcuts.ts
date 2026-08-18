import { markdownShortcutBindings, toggleShortcutBindings } from "@omd/engine"
import { formatBinding } from "./platform"

/**
 * Single source of truth for command shortcuts.
 *
 * - `WINDOW_SHORTCUTS` back both the palette display strings and the window
 *   keydown dispatch in `App.tsx`, so a new app-level shortcut is defined once.
 *   Bindings are stored normalized ("Mod+s"); display strings come from
 *   `formatBinding` per platform (spec D7).
 * - Format/mode shortcuts are owned by the engine keymap; the bindings are
 *   derived there (`markdownShortcutBindings` / `toggleShortcutBindings`) so the
 *   palette can never drift from the editor bindings.
 */

export interface WindowShortcut {
  /** AppCommand id this shortcut triggers. */
  id: string
  /** Normalized binding, e.g. "Mod+s"; display via formatBinding. */
  binding: string
  /** KeyboardEvent.key to match (case-insensitive). */
  key: string
  shift?: boolean
}

export const WINDOW_SHORTCUTS: readonly WindowShortcut[] = [
  { id: "preferences", binding: "Mod+,", key: "," },
  { id: "sidebar", binding: "Mod+\\", key: "\\" },
  { id: "outline", binding: "Mod+Shift+o", key: "O", shift: true },
  { id: "search", binding: "Mod+Shift+f", key: "f", shift: true },
  { id: "find", binding: "Mod+f", key: "f" },
  { id: "quick-open", binding: "Mod+p", key: "p" },
  { id: "open", binding: "Mod+o", key: "o" },
  { id: "tab", binding: "Mod+n", key: "n" },
  { id: "close", binding: "Mod+w", key: "w" },
  { id: "save", binding: "Mod+s", key: "s" },
  { id: "save-as", binding: "Mod+Shift+s", key: "s", shift: true },
]

export const FORMAT_SHORTCUT_BINDINGS: Readonly<Record<string, string>> = {
  ...markdownShortcutBindings,
  ...toggleShortcutBindings,
}

export function shortcutFor(commandId: string): string | undefined {
  const windowBinding = WINDOW_SHORTCUTS.find(shortcut => shortcut.id === commandId)?.binding
  if (windowBinding !== undefined) return formatBinding(windowBinding)
  const formatBinding_ = FORMAT_SHORTCUT_BINDINGS[commandId]
  return formatBinding_ !== undefined ? formatBinding(formatBinding_) : undefined
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
