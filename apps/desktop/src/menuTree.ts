export type ViewCheckKey = "source" | "sidebar" | "outline" | "typewriter" | "focus"

export interface MenuEntry {
  /** MENU_TO_COMMAND key, or "recents" for the Open Recent submenu. */
  id: string
  macOSOnly?: boolean
  separatorAfter?: boolean
  /** Present on toggle entries: the AppMenuViewState key rendered as a ✓. */
  checkKey?: ViewCheckKey
}

export interface MenuSection {
  labelKey: string
  entries: readonly MenuEntry[]
}

/**
 * In-app menubar for non-macOS platforms (one dropdown per top-level menu);
 * mirrors src-tauri/src/menu.rs (drift-tested in test/crossLayerMenu.test.ts).
 * Entry ids are the menu item ids menu.rs forwards, so the File menu uses the
 * legacy `new` id rather than its `new-tab` alias (both map to the same
 * palette command). App-menu/Help items (preferences, check-updates,
 * export-diagnostics) and the edit/quit entries have no macOS counterpart in
 * the tree because the native app menu already covers them there.
 */
export const APP_MENU_TREE: readonly MenuSection[] = [
  {
    labelKey: "menu.file",
    entries: [
      { id: "new" },
      { id: "open-file" },
      { id: "quick-open" },
      { id: "open-folder", separatorAfter: true },
      { id: "recents" },
      { id: "clear-recents", separatorAfter: true },
      { id: "close" },
      { id: "save" },
      { id: "save-as", separatorAfter: true },
      { id: "version-history" },
      { id: "export-html" },
      { id: "export-pdf", macOSOnly: true },
      { id: "export-image", macOSOnly: true, separatorAfter: true },
      { id: "preferences" },
      { id: "quit" },
    ],
  },
  {
    labelKey: "menu.edit",
    entries: [
      { id: "undo" },
      { id: "redo", separatorAfter: true },
      { id: "cut" },
      { id: "copy" },
      { id: "paste" },
      { id: "paste-plain-text" },
      { id: "select-all", separatorAfter: true },
      { id: "find" },
      { id: "search" },
    ],
  },
  {
    labelKey: "menu.format",
    entries: [
      { id: "bold" },
      { id: "italic" },
      { id: "strikethrough" },
      { id: "inline-code" },
      { id: "code-block", separatorAfter: true },
      { id: "heading-1" },
      { id: "heading-2" },
      { id: "heading-3" },
      { id: "heading-4" },
      { id: "heading-5" },
      { id: "heading-6", separatorAfter: true },
      { id: "ordered-list" },
      { id: "unordered-list" },
      { id: "blockquote" },
      { id: "link" },
      { id: "insert-image" },
    ],
  },
  {
    labelKey: "menu.view",
    entries: [
      { id: "view-source", checkKey: "source" },
      { id: "view-sidebar", checkKey: "sidebar" },
      { id: "view-outline", checkKey: "outline" },
      { id: "view-typewriter", checkKey: "typewriter" },
      { id: "view-focus", checkKey: "focus" },
      { id: "toggle-theme" },
      { id: "load-css" },
    ],
  },
  {
    labelKey: "menu.help",
    entries: [
      { id: "check-updates" },
      { id: "export-diagnostics", separatorAfter: true },
      { id: "about" },
    ],
  },
]
