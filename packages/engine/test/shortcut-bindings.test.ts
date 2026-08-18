import { describe, expect, it } from "vitest"
import {
  markdownKeyBindings,
  markdownShortcutBindings,
  markdownShortcutLabels,
  toggleKeyBindings,
  toggleShortcutBindings,
  toggleShortcutLabels,
} from "../src"

/** 与 desktop formatBinding(macOS) 等价的参考实现，锁死 display == mac 格式。 */
function macLabel(key: string): string {
  const parts = key.split("-").filter(part => part !== "")
  const modifiers = parts.slice(0, -1)
  const main = parts[parts.length - 1]
  const mac: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" }
  const order = ["Shift", "Alt", "Mod"]
  const sorted = order.filter(mod => modifiers.includes(mod)).map(mod => mac[mod])
  return [...sorted, main.toUpperCase()].join("")
}

describe("shortcut bindings", () => {
  it("exposes a binding for every labeled command", () => {
    for (const binding of markdownKeyBindings) {
      if (binding.display === undefined) continue
      expect(markdownShortcutBindings[binding.id]).toBe(binding.key)
    }
    for (const binding of toggleKeyBindings) {
      expect(toggleShortcutBindings[binding.id]).toBe(binding.key)
    }
  })
  it("mac display label equals formatted binding (no drift)", () => {
    for (const [id, label] of Object.entries(markdownShortcutLabels)) {
      expect(label).toBe(macLabel(markdownShortcutBindings[id]))
    }
    for (const [id, label] of Object.entries(toggleShortcutLabels)) {
      expect(label).toBe(macLabel(toggleShortcutBindings[id]))
    }
  })
})
