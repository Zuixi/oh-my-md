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
