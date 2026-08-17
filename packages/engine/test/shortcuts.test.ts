import { describe, expect, it } from "vitest"
import {
  markdownKeyBindings,
  markdownShortcutLabels,
  type MarkdownKeyBinding,
} from "../src/format/commands"
import { toggleKeyBindings, toggleShortcutLabels } from "../src/modes/livePreview"

/**
 * Guard against shortcut drift between the functional CodeMirror key (`key`)
 * and the macOS display label (`display`) the desktop palette renders. Both live
 * in the same binding entry, but the converter here still catches a key change
 * that left the display behind (and vice versa). The US-keyboard backtick is
 * Shift+` so `Mod-`` is displayed with the shift symbol.
 */
function cmKeyToDisplay(key: string): string {
  if (key === "Mod-`") return "⇧⌘`"
  const parts = key.split("-")
  const symbols: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" }
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

function displayLabels(): Readonly<Record<string, string>> {
  return { ...markdownShortcutLabels, ...toggleShortcutLabels }
}

describe("keymap display labels", () => {
  it("every primary binding's display matches its CodeMirror key", () => {
    const bindings: readonly (MarkdownKeyBinding | (typeof toggleKeyBindings)[number])[] = [
      ...markdownKeyBindings,
      ...toggleKeyBindings,
    ]
    for (const binding of bindings) {
      if (binding.display === undefined) continue
      expect(
        binding.display,
        `display for ${binding.id} (${binding.key}) does not match`,
      ).toBe(cmKeyToDisplay(binding.key))
    }
  })

  it("each shortcut label resolves to exactly one displayed binding", () => {
    const ids = [...markdownKeyBindings, ...toggleKeyBindings]
      .filter(binding => binding.display !== undefined)
      .map(binding => binding.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(Object.keys(displayLabels()))).toEqual(new Set(ids))
  })

  it("covers the desktop palette format commands", () => {
    expect(displayLabels()).toMatchObject({
      bold: "⌘B",
      italic: "⌘I",
      "heading-1": "⌘1",
      "ordered-list": "⌥⌘7",
      link: "⌘K",
      source: "⌘E",
    })
  })
})
