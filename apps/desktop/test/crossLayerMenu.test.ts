import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { MENU_TO_COMMAND } from "../src/commands"
import { formatBinding } from "../src/platform"
import { FORMAT_SHORTCUT_BINDINGS, WINDOW_SHORTCUTS } from "../src/shortcuts"

/**
 * Drift guard for the native macOS menu (`src-tauri/src/menu.rs`) against the
 * TypeScript shortcut/command layer. A menu item id that `MENU_TO_COMMAND` does
 * not know is dead, and an accelerator that disagrees with the window shortcut
 * (or palette label) for the same command shows the user two different
 * shortcuts for one action.
 *
 * Items whose id is prefixed `window-` are handled natively in Rust
 * (`handle_window_command` in `menu.rs`) and are never forwarded to the
 * webview, so they are exempt from the command/shortcut guards.
 */

const MENU_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/menu.rs"), "utf8")

interface MenuItem { id: string; accelerator: string | null }

function menuItems(): MenuItem[] {
  const items: MenuItem[] = []
  // 标签槽接受 l.field（i18n 后）或字符串字面量（历史上）：`(?:&?[\w.]+|"[^"]*")`
  const re = /\.item\(&(?:item|check_item)\(\s*app\s*,\s*"([^"]+)"\s*,\s*(?:&?[\w.]+|"[^"]*")\s*,\s*Some\("([^"]+)"\)\s*,?\s*\)\?\)/g
  for (const match of MENU_RS.matchAll(re)) items.push({ id: match[1], accelerator: match[2] })
  const noAccel = /\.item\(&(?:item|check_item)\(\s*app\s*,\s*"([^"]+)"\s*,\s*(?:&?[\w.]+|"[^"]*")\s*,\s*None\s*,?\s*\)\?\)/g
  for (const match of MENU_RS.matchAll(noAccel)) items.push({ id: match[1], accelerator: null })
  return items
}

function isNativeWindowItem(id: string): boolean {
  return id.startsWith("window-")
}

function rustAccelToDisplay(accelerator: string): string {
  const unescaped = accelerator.replace(/\\\\/g, "\\")
  const parts = unescaped.split("+")
  const symbols: Record<string, string> = { CmdOrCtrl: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" }
  const order: Record<string, number> = { "⌃": 0, "⌥": 1, "⇧": 2, "⌘": 3 }
  const modifiers = parts
    .slice(0, -1)
    .map(part => symbols[part])
    .filter(Boolean)
    .sort((a, b) => order[a] - order[b])
    .join("")
  const keyCap = parts[parts.length - 1]
  return modifiers + (keyCap.length === 1 ? keyCap.toUpperCase() : keyCap)
}

function shortcutDisplay(commandId: string): string | undefined {
  const windowBinding = WINDOW_SHORTCUTS.find(shortcut => shortcut.id === commandId)?.binding
  if (windowBinding !== undefined) return formatBinding(windowBinding, "macos")
  const formatBindingId = FORMAT_SHORTCUT_BINDINGS[commandId]
  return formatBindingId !== undefined ? formatBinding(formatBindingId, "macos") : undefined
}

describe("native menu ↔ TS command/shortcut wiring", () => {
  it("every forwarded menu item maps to a known command", () => {
    const items = menuItems()
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      if (isNativeWindowItem(item.id)) continue
      expect(
        MENU_TO_COMMAND[item.id],
        `menu item "${item.id}" is not in commands.ts MENU_TO_COMMAND`,
      ).toBeTruthy()
    }
  })

  it("native window menu items are all Rust-handled ids", () => {
    const native = menuItems().filter(item => isNativeWindowItem(item.id))
    expect(native.map(item => item.id).sort()).toEqual([
      "window-bring-all-to-front",
      "window-fullscreen",
      "window-minimize",
      "window-zoom",
    ])
  })

  it("menu accelerators match the window shortcut labels for the same command", () => {
    for (const item of menuItems()) {
      if (isNativeWindowItem(item.id)) continue
      if (!item.accelerator) continue
      const commandId = MENU_TO_COMMAND[item.id]
      const expected = shortcutDisplay(commandId)
      expect(expected, `command "${commandId}" has no window/format shortcut`).toBeTruthy()
      expect(
        rustAccelToDisplay(item.accelerator),
        `accelerator for "${item.id}" (${item.accelerator}) disagrees with shortcut for "${commandId}"`,
      ).toBe(expected)
    }
  })

  it("commands without a shortcut have no menu accelerator", () => {
    for (const item of menuItems()) {
      if (isNativeWindowItem(item.id)) continue
      if (item.accelerator) continue
      const commandId = MENU_TO_COMMAND[item.id]
      expect(
        shortcutDisplay(commandId),
        `command "${commandId}" has a shortcut but its menu item shows none`,
      ).toBeUndefined()
    }
  })
})
