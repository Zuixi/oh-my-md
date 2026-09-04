import type { PrepareUpdateRestartResult, UpdateCapability } from "./desktopServices"
import type { AdapterUpdate, UpdateAdapter } from "./updateAdapter"
import type { UpdateBlockedTab, UpdateRestartReadiness } from "./updateRestartReadiness"

export type UpdateSource = "startup" | "manual"
export type UpdateFailureKind =
  | "network"
  | "manifest"
  | "signature"
  | "download"
  | "platformUnsupported"
  | "flushTimeout"
  | "install"
  | "unknown"
export type UpdateStage = "check" | "download" | "readiness" | "install"

export interface AvailableUpdate {
  readonly version: string
  readonly notes: string
  readonly publishedAt?: string
}

export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly source: UpdateSource }
  | { readonly kind: "available"; readonly update: AvailableUpdate; readonly installSupported: boolean }
  | { readonly kind: "downloading"; readonly update: AvailableUpdate; readonly downloaded: number; readonly total?: number }
  | { readonly kind: "downloaded"; readonly update: AvailableUpdate }
  | { readonly kind: "blocked"; readonly update: AvailableUpdate; readonly reasons: readonly UpdateBlockedTab[] }
  | { readonly kind: "readyToInstall"; readonly update: AvailableUpdate }
  | { readonly kind: "installing"; readonly update: AvailableUpdate }
  | { readonly kind: "failed"; readonly stage: UpdateStage; readonly failure: UpdateFailureKind; readonly retryable: boolean }

/**
 * Desktop-owned update state machine (spec §9/§11/§12). Holds the raw Tauri
 * `Update` adapter handle privately so it never reaches React state, publishes
 * a serializable projection, and serializes every operation behind one guard.
 * It never downloads silently (startup checks stop at `available`), never
 * forces exit (a flush timeout aborts while the app keeps running), and never
 * installs before the separate `install()` action.
 */
export interface UpdateCoordinator {
  subscribe(listener: (state: UpdateState) => void): () => void
  check(source: UpdateSource): Promise<void>
  download(): Promise<void>
  requestInstall(): Promise<void>
  install(): Promise<void>
  dismiss(): void
  dispose(): void
}

export interface UpdateCoordinatorDependencies {
  readonly updater: UpdateAdapter
  readonly capability: () => Promise<UpdateCapability>
  readonly flushPendingEdits: () => void
  readonly checkRestartReadiness: () => UpdateRestartReadiness
  readonly prepareRestart: () => Promise<PrepareUpdateRestartResult>
  readonly openReleasePage: () => Promise<void>
  readonly reportManualFailure: (failure: UpdateFailureKind) => void
  /** Startup-check failure log sink (spec §10/§14): no user UI, only a structured log entry. */
  readonly logFailure: (failure: UpdateFailureKind) => void
  readonly notifyLatest: () => void
  readonly isWindows: () => boolean
  readonly classifyError: (error: unknown, stage: UpdateStage) => UpdateFailureKind
}

/** Failures where a plain retry of the same action may plausibly succeed. */
const RETRYABLE_FAILURES: ReadonlySet<UpdateFailureKind> = new Set(["network", "download", "unknown"])

function isRetryable(failure: UpdateFailureKind): boolean {
  return RETRYABLE_FAILURES.has(failure)
}

function toAvailable(handle: AdapterUpdate): AvailableUpdate {
  return { version: handle.version, notes: handle.notes, publishedAt: handle.publishedAt }
}

export function createUpdateCoordinator(dependencies: UpdateCoordinatorDependencies): UpdateCoordinator {
  const {
    updater,
    capability,
    flushPendingEdits,
    checkRestartReadiness,
    prepareRestart,
    openReleasePage,
    reportManualFailure,
    logFailure,
    notifyLatest,
    isWindows,
    classifyError,
  } = dependencies

  // One listener set, one private adapter handle, one disposed flag, one
  // operation guard. No persistence, channels, retries, backoff, or cancel.
  const listeners = new Set<(state: UpdateState) => void>()
  let privateHandle: AdapterUpdate | null = null
  let disposed = false
  let operationActive = false
  let current: UpdateState = { kind: "idle" }

  function publish(next: UpdateState): void {
    if (disposed) return
    current = next
    for (const listener of listeners) listener(next)
  }

  function closeHandleBestEffort(): void {
    const handle = privateHandle
    privateHandle = null
    if (handle) void handle.close().catch(() => {})
  }

  /** Replace the private handle, closing the previous one best-effort. */
  function remember(handle: AdapterUpdate): void {
    closeHandleBestEffort()
    if (disposed) {
      // A check that lands after disposal must not retain a live resource.
      void handle.close().catch(() => {})
      return
    }
    privateHandle = handle
  }

  async function check(source: UpdateSource): Promise<void> {
    if (disposed || operationActive) return
    operationActive = true
    publish({ kind: "checking", source })
    try {
      const platform = await capability()
      if (!platform.check) {
        if (source === "manual") {
          reportManualFailure("platformUnsupported")
          publish({ kind: "failed", stage: "check", failure: "platformUnsupported", retryable: false })
        } else {
          publish({ kind: "idle" })
        }
        return
      }
      const found = await updater.check()
      if (found === null) {
        closeHandleBestEffort()
        if (source === "manual") notifyLatest()
        publish({ kind: "idle" })
        return
      }
      remember(found)
      publish({ kind: "available", update: toAvailable(found), installSupported: platform.install })
    } catch (error) {
      const failure = classifyError(error, "check")
      if (source === "manual") {
        reportManualFailure(failure)
        publish({ kind: "failed", stage: "check", failure, retryable: isRetryable(failure) })
      } else {
        // Startup failures stay off the user UI; only the classified product
        // kind reaches the log sink (spec §10/§14), never raw error internals.
        logFailure(failure)
        publish({ kind: "idle" })
      }
    } finally {
      operationActive = false
    }
  }

  async function download(): Promise<void> {
    if (disposed || operationActive) return
    const state = current
    if (state.kind !== "available") return
    // Check-only packages (MSI, deb/rpm Linux) route to the Release page.
    if (!state.installSupported) {
      operationActive = true
      try {
        await openReleasePage()
      } finally {
        operationActive = false
      }
      return
    }
    const handle = privateHandle
    if (handle === null) return
    operationActive = true
    try {
      publish({ kind: "downloading", update: state.update, downloaded: 0 })
      let downloaded = 0
      let total: number | undefined
      await handle.download((event) => {
        if (event.kind === "started") total = event.total
        else if (event.kind === "progress") downloaded += event.chunkLength
        publish({ kind: "downloading", update: state.update, downloaded, total })
      })
      publish({ kind: "downloaded", update: state.update })
    } catch (error) {
      const failure = classifyError(error, "download")
      reportManualFailure(failure)
      publish({ kind: "failed", stage: "download", failure, retryable: isRetryable(failure) })
    } finally {
      operationActive = false
    }
  }

  async function requestInstall(): Promise<void> {
    if (disposed || operationActive) return
    const state = current
    if (state.kind !== "downloaded" && state.kind !== "blocked") return
    operationActive = true
    try {
      flushPendingEdits()
      const readiness = checkRestartReadiness()
      if (!readiness.ready) {
        publish({ kind: "blocked", update: state.update, reasons: readiness.reasons })
        return
      }
      const flush = await prepareRestart()
      if (flush.kind !== "ready") {
        reportManualFailure("flushTimeout")
        publish({ kind: "failed", stage: "readiness", failure: "flushTimeout", retryable: false })
        return
      }
      publish({ kind: "readyToInstall", update: state.update })
    } catch (error) {
      const failure = classifyError(error, "readiness")
      reportManualFailure(failure)
      publish({ kind: "failed", stage: "readiness", failure, retryable: isRetryable(failure) })
    } finally {
      operationActive = false
    }
  }

  async function install(): Promise<void> {
    if (disposed || operationActive) return
    const state = current
    if (state.kind !== "readyToInstall") return
    const handle = privateHandle
    if (handle === null) return
    operationActive = true
    try {
      // Edits made after the final confirmation must block installation: flush
      // pending materialization and re-run the document-safety gate exactly as
      // requestInstall does. A blocked install stays in `blocked` and keeps the
      // downloaded handle; the user saves and repeats requestInstall, which
      // performs prepareRestart again before a later install() may proceed.
      try {
        flushPendingEdits()
        const readiness = checkRestartReadiness()
        if (!readiness.ready) {
          publish({ kind: "blocked", update: state.update, reasons: readiness.reasons })
          return
        }
      } catch (error) {
        const failure = classifyError(error, "readiness")
        reportManualFailure(failure)
        publish({ kind: "failed", stage: "readiness", failure, retryable: isRetryable(failure) })
        return
      }
      publish({ kind: "installing", update: state.update })
      await handle.install()
      // On Windows the NSIS installer relaunches the app itself; the call may
      // terminate the process without resolving, so never require it to.
      if (!isWindows()) {
        await updater.relaunch()
      }
    } catch (error) {
      const failure = classifyError(error, "install")
      reportManualFailure(failure)
      publish({ kind: "failed", stage: "install", failure, retryable: isRetryable(failure) })
    } finally {
      operationActive = false
    }
  }

  function dismiss(): void {
    if (disposed) return
    publish({ kind: "idle" })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    listeners.clear()
    closeHandleBestEffort()
  }

  return {
    subscribe(listener: (state: UpdateState) => void): () => void {
      listeners.add(listener)
      if (!disposed) listener(current)
      return () => {
        listeners.delete(listener)
      }
    },
    check,
    download,
    requestInstall,
    install,
    dismiss,
    dispose,
  }
}
