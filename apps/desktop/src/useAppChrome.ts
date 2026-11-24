/**
 * Shell UI state: everything `App` renders from but that no document operation
 * owns — dialogs, palette, transient status, opening overlay, theme/settings
 * projections, sidebar/outline visibility, focus and typewriter modes.
 *
 * Keeping it in one place is what lets the composition root read as wiring
 * instead of forty `useState` lines.
 */
import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { AutoPairOptions } from "@omd/engine"
import type { DesktopServices } from "./desktopServices"
import type { EditorRegistry } from "./editorRegistry"
import type { LargeDocNotice } from "./editorScalePolicy"
import type { QuickOpenState } from "./documentOpen"
import type { UpdateState } from "./updateCoordinator"
import type { AppTheme } from "./theme"
import { DEFAULT_SETTINGS, sameAutoPair, type UserSettings } from "./settings"
import { persistSettingsChange } from "./settingsPersistence"
import { createTransientStatusNotifier } from "./transientStatus"
import { createSkippedStatusNotifier } from "./normalizationCoordinator"
import { forEachLiveView } from "./documentViews"
import { setEditorAutoPair, setEditorSpellcheck } from "./Editor"
import { readOutlineOpenPreference, readSidebarOpenPreference } from "./useShellEffects"
import { readSidebarWidth } from "./sidebarResize"
import { setLocale } from "./i18n"
import { useLoggingState } from "./useLoggingState"

export interface AppChromeState {
  readonly transientStatus: string | null
  readonly setTransientStatus: Dispatch<SetStateAction<string | null>>
  readonly showTransientStatus: (message: string) => void
  readonly updateState: UpdateState
  readonly setUpdateState: Dispatch<SetStateAction<UpdateState>>
  readonly openingRef: { current: boolean }
  readonly mountedRef: { current: boolean }
  readonly settings: UserSettings
  readonly setSettings: Dispatch<SetStateAction<UserSettings>>
  readonly settingsRef: { current: UserSettings }
  /** Promise of the last settings write; logging restart waits on it. */
  readonly settingsSaveRef: { current: Promise<boolean> }
  /** Resolved logging destination (opt-in; null until settings load). */
  readonly logState: import("./logging").LogStateView | null
  readonly handleSaveSettings: (next: UserSettings) => void
  /** Editor-wide pushes used when settings load or change. */
  readonly applySpellcheck: (on: boolean) => void
  readonly applyAutoPair: (next: AutoPairOptions) => void
  readonly settingsOpen: boolean
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>
  readonly aboutOpen: boolean
  readonly setAboutOpen: Dispatch<SetStateAction<boolean>>
  readonly theme: AppTheme
  readonly setTheme: Dispatch<SetStateAction<AppTheme>>
  readonly themeSyncReady: boolean
  readonly setThemeSyncReady: Dispatch<SetStateAction<boolean>>
  readonly customCss: string
  readonly setCustomCss: Dispatch<SetStateAction<string>>
  readonly focusMode: boolean
  readonly setFocusMode: Dispatch<SetStateAction<boolean>>
  readonly sidebarOpen: boolean
  readonly setSidebarOpen: Dispatch<SetStateAction<boolean>>
  readonly sidebarWidth: number
  readonly setSidebarWidth: Dispatch<SetStateAction<number>>
  readonly outlineOpen: boolean
  readonly setOutlineOpen: Dispatch<SetStateAction<boolean>>
  readonly typewriter: boolean
  readonly setTypewriter: Dispatch<SetStateAction<boolean>>
  readonly sourceMode: boolean
  readonly setSourceMode: Dispatch<SetStateAction<boolean>>
  readonly openingProgress: { bytesRead: number; byteLength: number } | null
  readonly setOpeningProgress: Dispatch<SetStateAction<{ bytesRead: number; byteLength: number } | null>>
  readonly openingLabel: string | null
  readonly setOpeningLabel: Dispatch<SetStateAction<string | null>>
  readonly paletteOpen: boolean
  readonly setPaletteOpen: Dispatch<SetStateAction<boolean>>
  readonly quickOpenState: QuickOpenState
  readonly setQuickOpenState: Dispatch<SetStateAction<QuickOpenState>>
  readonly largeDocNotice: LargeDocNotice | null
  readonly setLargeDocNotice: Dispatch<SetStateAction<LargeDocNotice | null>>
  readonly conflictFocusToken: number
  readonly setConflictFocusToken: Dispatch<SetStateAction<number>>
  readonly skippedMarkersMessage: string | null
  readonly showSkippedMarkersStatus: () => void
}

export function useAppChrome(input: {
  readonly services: DesktopServices
  readonly registry: EditorRegistry
}): AppChromeState {
  const { services, registry } = input
  const [transientStatus, setTransientStatus] = useState<string | null>(null)
  const transientStatusTimerRef = useRef<number | null>(null)
  const showTransientStatus = createTransientStatusNotifier(
    setTransientStatus,
    transientStatusTimerRef,
    id => { transientStatusTimerRef.current = id },
  )
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" })
  const openingRef = useRef(false)
  const mountedRef = useRef(false)
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<UserSettings>(settings)
  const settingsSaveRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [theme, setTheme] = useState<AppTheme>("light")
  // The native window theme is applied pre-paint by Rust from persisted
  // settings; frontend pushes wait for them so the title bar cannot flash.
  const [themeSyncReady, setThemeSyncReady] = useState(false)
  const logState = useLoggingState(services, themeSyncReady)
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpenPreference)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [outlineOpen, setOutlineOpen] = useState(readOutlineOpenPreference)
  const [typewriter, setTypewriter] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [openingProgress, setOpeningProgress] = useState<{ bytesRead: number; byteLength: number } | null>(null)
  const [openingLabel, setOpeningLabel] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickOpenState, setQuickOpenState] = useState<QuickOpenState>(
    { open: false, files: [], truncated: false, loading: false },
  )
  const [largeDocNotice, setLargeDocNotice] = useState<LargeDocNotice | null>(null)
  const [conflictFocusToken, setConflictFocusToken] = useState(0)
  const [skippedMarkersMessage, setSkippedMarkersMessage] = useState<string | null>(null)
  const skippedStatusTimerRef = useRef<number | null>(null)
  const showSkippedMarkersStatus = createSkippedStatusNotifier(
    setSkippedMarkersMessage, skippedStatusTimerRef,
    id => { skippedStatusTimerRef.current = id },
  )

  function applySpellcheck(on: boolean): void {
    forEachLiveView(registry, view => setEditorSpellcheck(view, on))
  }

  function applyAutoPair(next: AutoPairOptions): void {
    forEachLiveView(registry, view => setEditorAutoPair(view, next))
  }

  function handleSaveSettings(next: UserSettings): void {
    const sanitized = persistSettingsChange({
      current: settingsRef.current,
      next,
      slot: settingsSaveRef,
      services,
    })
    if (sanitized.spellcheck !== settingsRef.current.spellcheck) {
      applySpellcheck(sanitized.spellcheck)
    }
    if (!sameAutoPair(sanitized.autoPair, settingsRef.current.autoPair)) {
      applyAutoPair(sanitized.autoPair)
    }
    const localeChanged = sanitized.locale !== settingsRef.current.locale
    setSettings(sanitized)
    settingsRef.current = sanitized
    setTheme(sanitized.theme)
    if (localeChanged) setLocale(sanitized.locale)
  }

  return {
    transientStatus,
    setTransientStatus,
    showTransientStatus,
    updateState,
    setUpdateState,
    openingRef,
    mountedRef,
    settings,
    setSettings,
    settingsRef,
    settingsSaveRef,
    logState,
    handleSaveSettings,
    applySpellcheck,
    applyAutoPair,
    settingsOpen,
    setSettingsOpen,
    aboutOpen,
    setAboutOpen,
    theme,
    setTheme,
    themeSyncReady,
    setThemeSyncReady,
    customCss,
    setCustomCss,
    focusMode,
    setFocusMode,
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    outlineOpen,
    setOutlineOpen,
    typewriter,
    setTypewriter,
    sourceMode,
    setSourceMode,
    openingProgress,
    setOpeningProgress,
    openingLabel,
    setOpeningLabel,
    paletteOpen,
    setPaletteOpen,
    quickOpenState,
    setQuickOpenState,
    largeDocNotice,
    setLargeDocNotice,
    conflictFocusToken,
    setConflictFocusToken,
    skippedMarkersMessage,
    showSkippedMarkersStatus,
  }
}
