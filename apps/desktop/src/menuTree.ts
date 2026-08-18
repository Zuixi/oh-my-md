export interface MenuEntry {
  /** MENU_TO_COMMAND key, or "recents" for the Open Recent submenu. */
  id: string
  macOSOnly?: boolean
  separatorAfter?: boolean
}

export interface MenuSection {
  labelKey: string
  entries: readonly MenuEntry[]
}

/**
 * In-app menu for non-macOS platforms; mirrors src-tauri/src/menu.rs
 * (drift-tested in test/crossLayerMenu.test.ts). Entry ids are the menu item
 * ids menu.rs forwards, so the File section uses the legacy `new` id rather
 * than its `new-tab` alias (both map to the same palette command).
 */
export const APP_MENU_TREE: readonly MenuSection[] = [
  {
    labelKey: "menu.file",
    entries: [
      { id: "new" },
      { id: "open-file" },
      { id: "quick-open" },
      { id: "open-folder", separatorAfter: true },
      { id: "close" },
      { id: "save" },
      { id: "save-as", separatorAfter: true },
      { id: "version-history" },
      { id: "export-html" },
      { id: "export-pdf", macOSOnly: true },
      { id: "export-image", macOSOnly: true, separatorAfter: true },
      { id: "recents" },
      { id: "clear-recents" },
    ],
  },
  {
    labelKey: "menu.edit",
    entries: [{ id: "find" }, { id: "search" }],
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
      { id: "view-source" },
      { id: "view-sidebar" },
      { id: "view-outline" },
      { id: "view-typewriter" },
      { id: "view-focus" },
      { id: "toggle-theme" },
      { id: "load-css", separatorAfter: true },
      { id: "preferences" },
      { id: "check-updates" },
      { id: "export-diagnostics" },
    ],
  },
]
