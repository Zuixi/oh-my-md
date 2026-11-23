/**
 * Shell appearance and persistence effects: font variables, theme + native
 * window appearance, typewriter/focus dataset flags, sidebar/outline
 * persistence, the sidebar width re-clamp, the native View-menu mirror, and the
 * recent-file list.
 *
 * All of them are "state in, side effect out" with no orchestration, so they
 * live together instead of padding the composition root.
 */
import { useEffect } from "react"
import { applyTheme, type AppTheme } from "./theme"
import type { DesktopServices } from "./desktopServices"
import type { EditorStatusStore } from "./editorStatusStore"
import type { EditorRegistry } from "./editorRegistry"
import { editorStatus } from "./Editor"
import { clampSidebarWidth } from "./sidebarResize"
import { STORAGE_KEY_OUTLINE_OPEN, STORAGE_KEY_SIDEBAR_OPEN } from "./constants"
import type { UserSettings } from "./settings"

export interface ShellEffectsHost {
  readonly services: DesktopServices
  readonly registry: EditorRegistry
  readonly statusStore: EditorStatusStore
  readonly typewriter: boolean
  readonly focusMode: boolean
  readonly sourceMode: boolean
  readonly sidebarOpen: boolean
  readonly outlineOpen: boolean
  readonly activeTabId: number
  readonly recentsRef: { current: string[] }
  readonly setSidebarWidth: (update: (width: number) => number) => void
  readonly setSourceMode: (source: boolean) => void
}

/** Editor content styling comes from CSS variables, never from CodeMirror. */
export function useDocumentAppearance(input: {
  readonly settings: UserSettings
  readonly theme: AppTheme
  readonly themeSyncReady: boolean
  readonly customCss: string
  readonly typewriter: boolean
  readonly focusMode: boolean
  readonly services: DesktopServices
}): void {
  const { settings, theme, themeSyncReady, customCss, typewriter, focusMode, services } = input

  useEffect(() => {
    document.documentElement.style.setProperty("--omd-font-size", `${settings.fontSize}px`)
    document.documentElement.style.setProperty("--omd-line-height", `${settings.lineHeight}`)
    document.documentElement.style.setProperty("--omd-font-family", settings.fontFamily)
  }, [settings.fontSize, settings.lineHeight, settings.fontFamily])

  useEffect(() => {
    applyTheme(theme, customCss)
    if (!themeSyncReady) return
    // data-theme only restyles the webview; the native title bar follows the
    // window's own appearance. "system" clears the override.
    void services.setWindowTheme?.(theme === "system" ? null : theme)
  }, [theme, customCss, services, themeSyncReady])

  useEffect(() => {
    document.documentElement.dataset.typewriter = typewriter ? "on" : "off"
    document.documentElement.dataset.focus = focusMode ? "on" : "off"
  }, [typewriter, focusMode])
}

export function useShellEffects(host: ShellEffectsHost): void {
  const {
    services, registry, statusStore, sidebarOpen, outlineOpen,
    activeTabId, sourceMode, typewriter, focusMode,
  } = host

  useEffect(() => {
    writeFlag(STORAGE_KEY_SIDEBAR_OPEN, sidebarOpen ? "1" : "0")
  }, [sidebarOpen])

  useEffect(() => {
    writeFlag(STORAGE_KEY_OUTLINE_OPEN, outlineOpen ? "1" : "0")
  }, [outlineOpen])

  // A stored width can outlive a smaller window (relaunch, external resize);
  // re-clamp so the sidebar never eats the editor. Functional setState keeps
  // the listener registered once with no stale closure.
  useEffect(() => {
    const onWindowResize = () => {
      host.setSidebarWidth(prev => clampSidebarWidth(prev, window.innerWidth))
    }
    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [])

  // Mirror the active tab's editor mode into React so the native View menu can
  // reflect it. The active view is read, not tracked per tab.
  useEffect(() => {
    const status = editorStatus(registry.getActiveView())
    host.setSourceMode(status.mode === "source")
    // Activating a tab does not fire the editor's update listener, so the store
    // must be re-published here to reflect the newly active view.
    statusStore.publish(status)
  }, [activeTabId, statusStore, registry])

  useEffect(() => {
    void services.setViewMenuState?.({
      source: sourceMode,
      sidebar: sidebarOpen,
      outline: outlineOpen,
      typewriter,
      focus: focusMode,
    })
  }, [services, sourceMode, sidebarOpen, outlineOpen, typewriter, focusMode])

  useEffect(() => {
    host.recentsRef.current = services.loadRecents?.() ?? []
    void services.setRecentMenu?.(host.recentsRef.current)
  }, [services])
}

function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (tests, private mode) */
  }
}

/** Sidebar defaults to open; only an explicit "0" closes it. */
export function readSidebarOpenPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SIDEBAR_OPEN) !== "0"
  } catch {
    return true
  }
}

/** Outline defaults to closed; only an explicit "1" opens it. */
export function readOutlineOpenPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_OUTLINE_OPEN) === "1"
  } catch {
    return false
  }
}
