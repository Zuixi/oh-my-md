/**
 * Single source of truth for platform detection (spec D1).
 *
 * The Tauri webview is sandboxed and exposes no `process.platform`; the user
 * agent is the pragmatic equivalent. Unknown agents resolve to "macos" so
 * existing behavior and tests are unchanged on unrecognized environments.
 */
export type AppPlatform = "macos" | "windows" | "linux"

function detectPlatform(userAgent: string): AppPlatform {
  if (/Windows/i.test(userAgent)) return "windows"
  if (/Linux|X11/i.test(userAgent)) return "linux"
  return "macos"
}

export function currentPlatform(): AppPlatform {
  return detectPlatform(navigator.userAgent)
}

export function isMacOS(): boolean {
  return currentPlatform() === "macos"
}

export function isWindows(): boolean {
  return currentPlatform() === "windows"
}

export function isLinux(): boolean {
  return currentPlatform() === "linux"
}

const MAC_GLYPHS: Readonly<Record<string, string>> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" }
const MAC_ORDER = ["Shift", "Alt", "Mod"]
const WORD_ORDER = ["Mod", "Alt", "Shift"]

/** Renders a "Mod-Shift-x" / "Mod+Shift+x" binding for display (spec D7). */
export function formatBinding(binding: string, platform: AppPlatform = currentPlatform()): string {
  const parts = binding.split(/[-+]/).filter(part => part !== "")
  const main = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  if (platform === "macos") {
    const glyphs = MAC_ORDER.filter(mod => modifiers.includes(mod)).map(mod => MAC_GLYPHS[mod])
    return [...glyphs, main.toUpperCase()].join("")
  }
  const words = WORD_ORDER
    .filter(mod => modifiers.includes(mod))
    .map(mod => (mod === "Mod" ? "Ctrl" : mod))
  return [...words, main.toUpperCase()].join("+")
}
