/**
 * App-lifecycle effects: the one-shot startup sequence, the automatic-update
 * coordinator, the debounced session shard write, and the quit-time flush.
 *
 * They share one trait — each is a once-per-mount subscription whose callbacks
 * must read current state rather than capture it — so they live together here
 * and receive the shell's accessors once.
 */
import { useEffect, useRef } from "react"
import { loadInitialSettings, restoreDrafts, restoreSavedSession, type AppSessionInitHost } from "./appSessionInit"
import { dirtyRecoveryKeysFor, installSessionFlush } from "./appSessionFlush"
import { extractSessionState } from "./sessionRestore"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { DocumentViews } from "./documentViews"
import type { TabLifecycle } from "./appTabs"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { DesktopServices } from "./desktopServices"
import type { RecoveryWriter } from "./recoveryWriter"
import type { RecoveryDraft } from "./recoveryAdoption"
import type { UpdateAdapter } from "./updateAdapter"
import type { UpdateCoordinator, UpdateFailureKind, UpdateState } from "./updateCoordinator"
import {
  classifyUpdateError, createUpdateCoordinator,
} from "./updateCoordinator"
import { updateRestartReadiness } from "./updateRestartReadiness"
import { RELEASES_URL, STARTUP_UPDATE_CHECK_MS, windowsSetupAssetUrl } from "./constants"
import { flushLogs } from "./logging"
import { getGlobalLogger } from "./logger"
import { initLocale, t as localeT } from "./i18n"
import { isMainWindow } from "./windowScope"
import { isWindows } from "./platform"
import type { AppTheme } from "./theme"
import type { UserSettings } from "./settings"
import type { AutoPairOptions } from "@omd/engine"

/** Session writes are debounced to one per quiet second. */
export const SESSION_SAVE_DEBOUNCE_MS = 1000

export interface AppLifecycleHost {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly views: DocumentViews
  readonly tabs: TabLifecycle
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly recoveryWriter: RecoveryWriter
  readonly mountedRef: { current: boolean }
  readonly openExternalRef: { current: (path: string) => Promise<void> }
  readonly updateCoordinatorRef: { current: UpdateCoordinator | null }
  readonly updateAdapter: UpdateAdapter
  readonly logUpdateFailure: (failure: UpdateFailureKind) => void
  readonly setUpdateState: (state: UpdateState) => void
  readonly commitWorkspace: (workspace: import("./workspace").Workspace) => void
  readonly getSettings: () => UserSettings
  readonly commitSettings: (settings: UserSettings) => void
  readonly commitTheme: (theme: AppTheme) => void
  readonly setThemeSyncReady: () => void
  readonly applySpellcheck: (on: boolean) => void
  readonly applyAutoPair: (next: AutoPairOptions) => void
  readonly adoptRecovery: (draft: RecoveryDraft) => number | null
  readonly isOpening: () => boolean
  /** Re-arms controllers a previous StrictMode cleanup disposed. */
  readonly resetDisposed: () => void
  /** Tears down everything else this mount owns (autosave, outline, open). */
  readonly dispose: () => void
}

export function useAppLifecycleEffects(host: AppLifecycleHost): void {
  const { services, store, views } = host
  const startupStartedRef = useRef(false)
  const localeInitRef = useRef(false)
  const sessionSaveTimerRef = useRef<number | null>(null)
  // The debounced save may still be in Rust; quit waits for it so it cannot
  // land after the final shard write and resurrect a closed window's shard.
  const sessionSaveInFlightRef = useRef<Promise<void> | null>(null)
  const updateCheckTimerRef = useRef<number | null>(null)

  useEffect(() => {
    host.mountedRef.current = true
    host.resetDisposed()
    views.materializer.reset()
    views.ensureViews()
    if (!startupStartedRef.current) {
      startupStartedRef.current = true
      void (async () => {
        const sessionInit: AppSessionInitHost = {
          services,
          documentScaleRegistry: host.documentScaleRegistry,
          isMounted: () => host.mountedRef.current,
          applySpellcheck: host.applySpellcheck,
          applyAutoPair: host.applyAutoPair,
          getSettingsState: host.getSettings,
          commitSettings: host.commitSettings,
          commitTheme: host.commitTheme,
          getWorkspace: () => store.getWorkspace(),
          commitWorkspace: host.commitWorkspace,
          getContents: tabId => store.getTabDoc(tabId),
          setContents: (tabId, contents) => store.setTabDoc(tabId, contents),
          resetTabDocument: (session, contents) => views.resetTabDocument(session, contents),
          ensureDraftTarget: host.tabs.loadDraftTarget,
          adoptRecovery: host.adoptRecovery,
          syncDoc: views.syncDoc,
        }
        const initial = await loadInitialSettings(sessionInit)
        if (host.mountedRef.current) host.setThemeSyncReady()
        if (!localeInitRef.current) {
          localeInitRef.current = true
          initLocale(initial.locale, locale => { void services.setMenuLocale?.(locale) })
        }
        const pendingOpen = await services.takePendingOpenFiles?.() ?? []
        // A launch request supersedes the shard, so nothing is claimed and any
        // leftover Hot Exit drafts fall through to the crash-recovery prompt.
        let claimedRecoveryKeys: ReadonlySet<string> = new Set()
        if (pendingOpen.length > 0) {
          for (const path of pendingOpen) await host.openExternalRef.current(path)
        } else {
          // Session shards are per-window (get_session_state resolves the
          // calling webview), so EVERY window consults its own shard here.
          claimedRecoveryKeys = await restoreSavedSession(sessionInit)
        }
        // Draft recovery is app-global and main-gated: every unclaimed record is
        // offered after the shard/open requests have settled.
        if (isMainWindow()) await restoreDrafts(sessionInit, claimedRecoveryKeys)
      })()
    }
    return () => {
      host.mountedRef.current = false
      views.materializer.destroy()
      host.registry.destroyAll()
      host.dispose()
    }
  }, [])

  // Automatic updates (spec §10): one coordinator per mounted app, one startup
  // check. Creating it in the effect also survives StrictMode's double-invoke:
  // each pass builds a fresh coordinator instead of reusing a disposed one.
  useEffect(() => {
    const coordinator = createUpdateCoordinator({
      updater: host.updateAdapter,
      capability: async () =>
        services.updateCapability?.() ?? { check: false, install: false, reason: "development" },
      flushPendingEdits: () => views.materializer.flush(),
      checkRestartReadiness: () => updateRestartReadiness({
        workspace: store.getWorkspace(),
        contentsByTab: store.docs(),
        saveStates: store.getSaveStateByTab(),
        normalization: store.getNormalizationByTab(),
        opening: host.isOpening(),
      }),
      prepareRestart: async () => {
        const prepare = services.prepareUpdateRestart
        if (!prepare) throw new Error("update restart is not supported here")
        return prepare()
      },
      openReleasePage: async () => { await services.openExternal?.(RELEASES_URL) },
      openManualDownload: async version => { await services.openExternal?.(windowsSetupAssetUrl(version)) },
      reportManualFailure: failure => {
        if (host.mountedRef.current) services.reportError(localeT(`update.failure.${failure}`))
      },
      logFailure: host.logUpdateFailure,
      notifyLatest: () => { services.notifySuccess?.(localeT("update.current")) },
      isWindows: () => isWindows(),
      classifyError: classifyUpdateError,
    })
    host.updateCoordinatorRef.current = coordinator
    const unsubscribe = coordinator.subscribe(host.setUpdateState)
    updateCheckTimerRef.current = window.setTimeout(() => {
      void coordinator.check("startup")
    }, STARTUP_UPDATE_CHECK_MS)
    return () => {
      if (updateCheckTimerRef.current !== null) {
        window.clearTimeout(updateCheckTimerRef.current)
        updateCheckTimerRef.current = null
      }
      unsubscribe()
      coordinator.dispose()
      if (host.updateCoordinatorRef.current === coordinator) host.updateCoordinatorRef.current = null
    }
  }, [])

  const tabs = store.getWorkspace().tabs
  useEffect(() => {
    views.ensureViews()
    // `ensureViews` materializes every newly mounted tab (new tab, open path,
    // restore). Activation is not the only way the live set grows, so the
    // budget has to be enforced here as well as in `activateTab`.
    host.tabs.evictOverBudget()
  }, [tabs])

  const folder = store.getWorkspace().folder
  const activeId = store.getWorkspace().activeId
  useEffect(() => {
    if (!services.saveSessionState || !host.mountedRef.current) return
    if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current)
    sessionSaveTimerRef.current = window.setTimeout(() => {
      const current = store.getWorkspace()
      const dirtyKeys = dirtyRecoveryKeysFor(current, tabId => store.getTabDoc(tabId))
      const state = extractSessionState(current, dirtyKeys.size > 0 ? dirtyKeys : undefined)
      const save = services.saveSessionState?.(state) ?? Promise.resolve()
      sessionSaveInFlightRef.current = save
      // Local catch: a failed save is absorbed here so the in-flight promise
      // cannot become an unhandled rejection (the flush side has its own guard),
      // but it is still logged once rather than disappearing.
      void save.catch(error => {
        getGlobalLogger().warn(
          "session",
          `debounced session save failed: ${error instanceof Error ? error.message : "unknown"}`,
        )
      })
    }, SESSION_SAVE_DEBOUNCE_MS)
    return () => {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current)
    }
  }, [folder, tabs, activeId, services])

  // Quit-time flush: materialize, write every dirty recovery, then the shard
  // and ack. Rust's CloseRequested/ExitRequested depend on that order.
  useEffect(() => installSessionFlush({
    services,
    getWorkspace: () => store.getWorkspace(),
    getContents: tabId => store.getTabDoc(tabId),
    getSessionSaveTimer: () => sessionSaveTimerRef.current,
    clearSessionSaveTimer: () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current)
        sessionSaveTimerRef.current = null
      }
    },
    getSessionSaveInFlight: () => sessionSaveInFlightRef.current,
    getRecoveryWriter: () => host.recoveryWriter,
    flushMaterializer: () => views.materializer.flush(),
    flushLogs,
  }), [services])
}
