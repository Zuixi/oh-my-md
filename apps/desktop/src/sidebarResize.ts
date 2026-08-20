/**
 * Pure helpers for the file-sidebar drag resizer. Kept out of App.tsx so the
 * clamp/persistence logic stays unit-testable without the app harness.
 */
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WINDOW_FRACTION,
  SIDEBAR_MIN_WIDTH,
  STORAGE_KEY_SIDEBAR_WIDTH,
} from "./constants"

export function clampSidebarWidth(px: number, viewportWidth: number): number {
  const max = Math.floor(viewportWidth * SIDEBAR_MAX_WINDOW_FRACTION)
  const upper = Math.max(SIDEBAR_MIN_WIDTH, max)
  return Math.min(upper, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)))
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SIDEBAR_WIDTH)
    const parsed = raw === null ? Number.NaN : Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH
    return clampSidebarWidth(parsed, window.innerWidth)
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY_SIDEBAR_WIDTH, String(Math.round(px)))
  } catch { /* storage unavailable (tests, private mode) */ }
}
