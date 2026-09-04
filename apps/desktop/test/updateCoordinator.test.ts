import { describe, expect, it, vi } from "vitest"
import {
  createUpdateCoordinator,
  type AvailableUpdate,
  type UpdateCoordinator,
  type UpdateCoordinatorDependencies,
  type UpdateState,
} from "../src/updateCoordinator"
import type { PrepareUpdateRestartResult } from "../src/desktopServices"
import type { AdapterDownloadEvent, AdapterUpdate, UpdateAdapter } from "../src/updateAdapter"
import type { UpdateBlockedTab } from "../src/updateRestartReadiness"

const UPDATE: AvailableUpdate = {
  version: "0.1.1",
  notes: "Bug fixes and polish.",
  publishedAt: "2026-09-10T10:00:00Z",
}

interface FakeAdapterUpdate {
  readonly currentVersion: string
  readonly version: string
  readonly notes: string
  readonly publishedAt?: string
  download(onEvent?: (event: AdapterDownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

interface FakeUpdater {
  check: ReturnType<typeof vi.fn>
  relaunch: ReturnType<typeof vi.fn>
}

function makeHandle(overrides: Partial<FakeAdapterUpdate> = {}): FakeAdapterUpdate {
  return {
    currentVersion: "0.0.1",
    version: "0.1.1",
    notes: "Bug fixes and polish.",
    publishedAt: "2026-09-10T10:00:00Z",
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeEnv(overrides: Partial<UpdateCoordinatorDependencies> = {}) {
  const handle = makeHandle()
  const updater: FakeUpdater = {
    check: vi.fn().mockResolvedValue(handle),
    relaunch: vi.fn().mockResolvedValue(undefined),
  }
  const deps: UpdateCoordinatorDependencies = {
    updater: updater as unknown as UpdateAdapter,
    capability: vi.fn().mockResolvedValue({ check: true, install: true }),
    flushPendingEdits: vi.fn(),
    checkRestartReadiness: vi.fn().mockReturnValue({ ready: true, reasons: [] }),
    prepareRestart: vi.fn<() => Promise<PrepareUpdateRestartResult>>().mockResolvedValue({ kind: "ready" }),
    openReleasePage: vi.fn().mockResolvedValue(undefined),
    reportManualFailure: vi.fn(),
    logFailure: vi.fn(),
    notifyLatest: vi.fn(),
    isWindows: vi.fn().mockReturnValue(false),
    classifyError: vi.fn().mockReturnValue("unknown"),
    ...overrides,
  }
  return { deps, handle, updater }
}

function collect(coordinator: UpdateCoordinator): {
  states: UpdateState[]
  unsubscribe: () => void
} {
  const states: UpdateState[] = []
  const unsubscribe = coordinator.subscribe((state) => states.push(state))
  return { states, unsubscribe }
}

function last(states: UpdateState[]): UpdateState {
  return states[states.length - 1]!
}

/**
 * Returns state history via a fresh subscription. `subscribe` replays the
 * current state, so a late subscription sees at least the terminal state;
 * used only for tests asserting on the final projection.
 */
function statesOf(coordinator: UpdateCoordinator): UpdateState[] {
  return collect(coordinator).states
}

/** Drives the default fixture through check -> download -> downloaded. */
async function reachDownloaded(coordinator: UpdateCoordinator): Promise<void> {
  await coordinator.check("manual")
  await coordinator.download()
}

function deferredCheck(overrides: Partial<UpdateCoordinatorDependencies> = {}): {
  deps: UpdateCoordinatorDependencies
  updater: FakeUpdater
  resolveCheck: (handle: AdapterUpdate | null) => void
} {
  let resolveCheck: (handle: AdapterUpdate | null) => void = () => {}
  const updater: FakeUpdater = {
    check: vi.fn().mockReturnValue(
      new Promise<AdapterUpdate | null>((resolve) => {
        resolveCheck = resolve
      }),
    ),
    relaunch: vi.fn().mockResolvedValue(undefined),
  }
  const env = makeEnv({ updater: updater as unknown as UpdateAdapter, ...overrides })
  return { deps: env.deps, updater, resolveCheck }
}

describe("createUpdateCoordinator", () => {
  it("starts idle and replays the current state on subscribe", () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)
    expect(states).toEqual([{ kind: "idle" }])
  })

  it("stops notifying a listener after unsubscribe", async () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states, unsubscribe } = collect(coordinator)
    unsubscribe()

    await coordinator.check("manual")

    expect(states).toEqual([{ kind: "idle" }])
  })

  it("publishes manual check -> available with install support and no private metadata", async () => {
    const { deps, updater } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(updater.check).toHaveBeenCalledTimes(1)
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "manual" },
      { kind: "available", installSupported: true, update: UPDATE },
    ])
  })

  it("publishes startup check -> available with the startup source", async () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("startup")

    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "startup" },
      { kind: "available", installSupported: true, update: UPDATE },
    ])
  })

  it("omits publishedAt from available when the update lacks one", async () => {
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(makeHandle({ publishedAt: undefined }))
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(last(states)).toEqual({
      kind: "available",
      installSupported: true,
      update: { version: "0.1.1", notes: "Bug fixes and polish." },
    })
  })

  it("publishes available with installSupported false for check-only packages", async () => {
    const { deps } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: true, install: false, reason: "manualPackage" }),
    })
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")

    expect(last(statesOf(coordinator))).toEqual({
      kind: "available",
      installSupported: false,
      update: UPDATE,
    })
  })

  it("notifies that the app is current and returns idle when a manual check finds no update", async () => {
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(null)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(deps.notifyLatest).toHaveBeenCalledTimes(1)
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "manual" },
      { kind: "idle" },
    ])
  })

  it("stays silent when a startup check finds no update", async () => {
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(null)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("startup")

    expect(deps.notifyLatest).not.toHaveBeenCalled()
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "startup" },
      { kind: "idle" },
    ])
  })

  it("publishes idle without any user callback when a startup check fails", async () => {
    const boom = new Error("network down")
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("network") })
    updater.check.mockRejectedValueOnce(boom)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("startup")

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "check")
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(deps.notifyLatest).not.toHaveBeenCalled()
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "startup" },
      { kind: "idle" },
    ])
  })
  it("logs a startup check failure (including signature/manifest) through logFailure with no user UI", async () => {
    const boom = new Error("minisign signature mismatch")
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("signature") })
    updater.check.mockRejectedValueOnce(boom)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("startup")

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "check")
    expect(deps.logFailure).toHaveBeenCalledTimes(1)
    expect(deps.logFailure).toHaveBeenCalledWith("signature")
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(deps.notifyLatest).not.toHaveBeenCalled()
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "startup" },
      { kind: "idle" },
    ])
  })

  it("keeps manual check failures on the user-facing path without logFailure", async () => {
    const boom = new Error("bad manifest")
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("manifest") })
    updater.check.mockRejectedValueOnce(boom)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")

    expect(deps.logFailure).not.toHaveBeenCalled()
    expect(deps.reportManualFailure).toHaveBeenCalledWith("manifest")
    expect(last(statesOf(coordinator))).toEqual({
      kind: "failed",
      stage: "check",
      failure: "manifest",
      retryable: false,
    })
  })

  it("reports and publishes a manual check failure with the classified kind", async () => {
    const boom = new Error("bad manifest")
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("manifest") })
    updater.check.mockRejectedValueOnce(boom)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "check")
    expect(deps.reportManualFailure).toHaveBeenCalledWith("manifest")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "check",
      failure: "manifest",
      retryable: false,
    })
  })

  it.each([
    ["network", true],
    ["download", true],
    ["unknown", true],
    ["manifest", false],
    ["signature", false],
    ["platformUnsupported", false],
    ["flushTimeout", false],
    ["install", false],
  ] as const)("maps a %s failure to retryable=%s", async (kind, retryable) => {
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue(kind) })
    updater.check.mockRejectedValueOnce(new Error(kind))
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")

    expect(deps.reportManualFailure).toHaveBeenCalledWith(kind)
    expect(last(statesOf(coordinator))).toEqual({
      kind: "failed",
      stage: "check",
      failure: kind,
      retryable,
    })
  })

  it("routes a manual check to platform-unsupported failure when the platform cannot check", async () => {
    const { deps, updater } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: false, install: false, reason: "development" }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(updater.check).not.toHaveBeenCalled()
    expect(deps.reportManualFailure).toHaveBeenCalledWith("platformUnsupported")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "check",
      failure: "platformUnsupported",
      retryable: false,
    })
  })

  it("keeps a startup check silent when the platform cannot check", async () => {
    const { deps, updater } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: false, install: false, reason: "unsupported" }),
    })
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("startup")

    expect(updater.check).not.toHaveBeenCalled()
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(deps.notifyLatest).not.toHaveBeenCalled()
  })

  it("classifies a capability failure as a check-stage failure", async () => {
    const boom = new Error("capability broken")
    const { deps } = makeEnv({
      capability: vi.fn().mockRejectedValue(boom),
      classifyError: vi.fn().mockReturnValue("unknown"),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "check")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "check",
      failure: "unknown",
      retryable: true,
    })
  })

  it("allows a new manual check after a failure", async () => {
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("network") })
    updater.check.mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce(makeHandle())
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.check("manual")

    expect(updater.check).toHaveBeenCalledTimes(2)
    expect(last(statesOf(coordinator))).toEqual({
      kind: "available",
      installSupported: true,
      update: UPDATE,
    })
  })

  it("ignores a repeated check while a check is already running", async () => {
    const { deps, updater, resolveCheck } = deferredCheck()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    const first = coordinator.check("manual")
    const second = coordinator.check("startup")
    await second
    resolveCheck(null)
    await first

    expect(updater.check).toHaveBeenCalledTimes(1)
    expect(deps.reportManualFailure).not.toHaveBeenCalled()
    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "manual" },
      { kind: "idle" },
    ])
  })

  it("treats an install request during a check as a no-op", async () => {
    const { deps, resolveCheck } = deferredCheck()
    const coordinator = createUpdateCoordinator(deps)

    const checkPromise = coordinator.check("manual")
    await coordinator.requestInstall()
    resolveCheck(makeHandle())
    await checkPromise

    expect(deps.flushPendingEdits).not.toHaveBeenCalled()
    expect(deps.prepareRestart).not.toHaveBeenCalled()
  })

  it("accumulates chunk lengths into download progress and keeps the same handle", async () => {
    const events: AdapterDownloadEvent[] = [
      { kind: "started", total: 1000 },
      { kind: "progress", chunkLength: 120 },
      { kind: "progress", chunkLength: 180 },
      { kind: "finished" },
    ]
    const handle = makeHandle({
      download: vi.fn(async (onEvent) => {
        if (onEvent) for (const event of events) onEvent(event)
      }),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    await coordinator.download()

    expect(states).toEqual([
      { kind: "idle" },
      { kind: "checking", source: "manual" },
      { kind: "available", installSupported: true, update: UPDATE },
      { kind: "downloading", update: UPDATE, downloaded: 0 },
      { kind: "downloading", update: UPDATE, downloaded: 0, total: 1000 },
      { kind: "downloading", update: UPDATE, downloaded: 120, total: 1000 },
      { kind: "downloading", update: UPDATE, downloaded: 300, total: 1000 },
      { kind: "downloading", update: UPDATE, downloaded: 300, total: 1000 },
      { kind: "downloaded", update: UPDATE },
    ])
  })

  it("keeps total absent while the download size is unknown", async () => {
    const handle = makeHandle({
      download: vi.fn(async (onEvent) => onEvent?.({ kind: "progress", chunkLength: 8 })),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    await coordinator.download()

    const downloading = states.filter((state) => state.kind === "downloading")
    expect(downloading).toEqual([
      { kind: "downloading", update: UPDATE, downloaded: 0 },
      { kind: "downloading", update: UPDATE, downloaded: 8 },
    ])
  })

  it("classifies and reports a download failure as retryable", async () => {
    const boom = new Error("interrupted")
    const handle = makeHandle({ download: vi.fn().mockRejectedValue(boom) })
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("download") })
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    await coordinator.download()

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "download")
    expect(deps.reportManualFailure).toHaveBeenCalledWith("download")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "download",
      failure: "download",
      retryable: true,
    })
  })

  it("ignores download outside the available state", async () => {
    const { deps, handle } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.download()

    expect(handle.download).not.toHaveBeenCalled()
  })

  it("opens the Release page instead of downloading for check-only packages", async () => {
    const { deps, handle } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: true, install: false, reason: "manualPackage" }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    await coordinator.download()

    expect(deps.openReleasePage).toHaveBeenCalledTimes(1)
    expect(handle.download).not.toHaveBeenCalled()
    expect(last(states)).toEqual({
      kind: "available",
      installSupported: false,
      update: UPDATE,
    })
  })

  it("ignores a second download while a download is running", async () => {
    let finishDownload: () => void = () => {}
    const handle = makeHandle({
      download: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
      ),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    const first = coordinator.download()
    const second = coordinator.download()
    await second
    finishDownload()
    await first

    expect(handle.download).toHaveBeenCalledTimes(1)
  })

  it("ignores a check while a download is running", async () => {
    let finishDownload: () => void = () => {}
    const handle = makeHandle({
      download: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
      ),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    const downloadPromise = coordinator.download()
    await coordinator.check("manual")
    finishDownload()
    await downloadPromise

    expect(updater.check).toHaveBeenCalledTimes(1)
  })

  it("flushes edits, classifies readiness, and requests a restart flush into readyToInstall", async () => {
    const order: string[] = []
    const { deps, handle } = makeEnv({
      flushPendingEdits: vi.fn(() => {
        order.push("flush")
      }),
      checkRestartReadiness: vi.fn(() => {
        order.push("readiness")
        return { ready: true, reasons: [] }
      }),
      prepareRestart: vi.fn<() => Promise<PrepareUpdateRestartResult>>(async () => {
        order.push("prepare")
        return { kind: "ready" }
      }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()

    expect(order).toEqual(["flush", "readiness", "prepare"])
    expect(handle.install).not.toHaveBeenCalled()
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })
  })

  it("presents blockers and skips the restart flush when readiness fails", async () => {
    const reasons: UpdateBlockedTab[] = [{ tabId: 1, displayName: "draft.md", reason: "dirtyDocument" }]
    const { deps } = makeEnv({
      checkRestartReadiness: vi.fn().mockReturnValue({ ready: false, reasons }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()

    expect(deps.flushPendingEdits).toHaveBeenCalledTimes(1)
    expect(deps.prepareRestart).not.toHaveBeenCalled()
    expect(last(states)).toEqual({ kind: "blocked", update: UPDATE, reasons })
  })

  it("re-evaluates readiness when asked again from the blocked state", async () => {
    const { deps } = makeEnv({
      checkRestartReadiness: vi
        .fn()
        .mockReturnValueOnce({
          ready: false,
          reasons: [{ tabId: 1, displayName: "a.md", reason: "activeSave" }] satisfies UpdateBlockedTab[],
        })
        .mockReturnValueOnce({ ready: true, reasons: [] }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    expect(last(states)).toEqual({
      kind: "blocked",
      update: UPDATE,
      reasons: [{ tabId: 1, displayName: "a.md", reason: "activeSave" }],
    })

    await coordinator.requestInstall()
    expect(deps.prepareRestart).toHaveBeenCalledTimes(1)
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })
  })

  it("aborts with a flush-timeout failure while keeping the app running", async () => {
    const { deps } = makeEnv({ prepareRestart: vi.fn<() => Promise<PrepareUpdateRestartResult>>().mockResolvedValue({ kind: "timedOut" }) })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()

    expect(deps.reportManualFailure).toHaveBeenCalledWith("flushTimeout")
    expect(states.some((state) => state.kind === "installing")).toBe(false)
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "readiness",
      failure: "flushTimeout",
      retryable: false,
    })
  })

  it("classifies a readiness-stage throw through the dependency", async () => {
    const boom = new Error("flush broken")
    const { deps } = makeEnv({
      prepareRestart: vi.fn().mockRejectedValue(boom),
      classifyError: vi.fn().mockReturnValue("unknown"),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "readiness")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "readiness",
      failure: "unknown",
      retryable: true,
    })
  })

  it("ignores an install request while the update is only available", async () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.requestInstall()

    expect(deps.flushPendingEdits).not.toHaveBeenCalled()
    expect(deps.checkRestartReadiness).not.toHaveBeenCalled()
  })

  it("keeps the final confirmation separate: requestInstall never installs", async () => {
    const { deps, handle } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()

    expect(handle.install).not.toHaveBeenCalled()
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })
  })

  it("re-checks readiness at install time and blocks on edits made after the final confirmation", async () => {
    const reasons: UpdateBlockedTab[] = [{ tabId: 1, displayName: "draft.md", reason: "dirtyDocument" }]
    const order: string[] = []
    const { deps, handle, updater } = makeEnv({
      flushPendingEdits: vi.fn(() => { order.push("flush") }),
      checkRestartReadiness: vi
        .fn()
        .mockImplementationOnce(() => { order.push("readiness"); return { ready: true, reasons: [] } })
        .mockImplementationOnce(() => { order.push("readiness"); return { ready: false, reasons } }),
      prepareRestart: vi.fn<() => Promise<PrepareUpdateRestartResult>>(async () => {
        order.push("prepare")
        return { kind: "ready" }
      }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })

    await coordinator.install()

    expect(order).toEqual(["flush", "readiness", "prepare", "flush", "readiness"])
    expect(handle.install).not.toHaveBeenCalled()
    expect(updater.relaunch).not.toHaveBeenCalled()
    expect(last(states)).toEqual({ kind: "blocked", update: UPDATE, reasons })
  })

  it("requires a repeated requestInstall after an install-time block before the installer runs", async () => {
    const reasons: UpdateBlockedTab[] = [{ tabId: 1, displayName: "draft.md", reason: "saveConflict" }]
    const { deps, handle } = makeEnv({
      checkRestartReadiness: vi
        .fn()
        .mockReturnValueOnce({ ready: true, reasons: [] })
        .mockReturnValueOnce({ ready: false, reasons })
        .mockReturnValueOnce({ ready: true, reasons: [] })
        .mockReturnValueOnce({ ready: true, reasons: [] }),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    await coordinator.install()
    expect(last(states)).toEqual({ kind: "blocked", update: UPDATE, reasons })

    // The user saves and repeats the confirmation flow; prepareRestart runs
    // again, and only the second install() reaches the installer.
    await coordinator.requestInstall()
    expect(deps.prepareRestart).toHaveBeenCalledTimes(2)
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })

    await coordinator.install()
    expect(handle.install).toHaveBeenCalledTimes(1)
  })

  it("reports an install-time readiness throw through the readiness stage", async () => {
    const boom = new Error("readiness broken")
    const { deps } = makeEnv({
      checkRestartReadiness: vi
        .fn()
        .mockReturnValueOnce({ ready: true, reasons: [] })
        .mockImplementationOnce(() => { throw boom }),
      classifyError: vi.fn().mockReturnValue("unknown"),
    })
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    await coordinator.install()

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "readiness")
    expect(deps.reportManualFailure).toHaveBeenCalledWith("unknown")
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "readiness",
      failure: "unknown",
      retryable: true,
    })
  })

  it("relaunches only after install resolves on non-Windows", async () => {
    let finishInstall: () => void = () => {}
    const handle = makeHandle({
      install: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishInstall = resolve
        }),
      ),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    expect(last(states)).toEqual({ kind: "readyToInstall", update: UPDATE })

    const installPromise = coordinator.install()
    expect(handle.install).toHaveBeenCalledTimes(1)
    expect(updater.relaunch).not.toHaveBeenCalled()
    expect(last(states)).toEqual({ kind: "installing", update: UPDATE })

    finishInstall()
    await installPromise
    expect(updater.relaunch).toHaveBeenCalledTimes(1)
  })

  it("keeps one private handle across check, download, and install", async () => {
    const handle = makeHandle()
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    await coordinator.install()

    expect(handle.download).toHaveBeenCalledTimes(1)
    expect(handle.install).toHaveBeenCalledTimes(1)
  })

  it("calls the installer on Windows without requiring resolution or relaunching", async () => {
    const handle = makeHandle({ install: vi.fn().mockReturnValue(new Promise<void>(() => {})) })
    const { deps, updater } = makeEnv({ isWindows: vi.fn().mockReturnValue(true) })
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    void coordinator.install()

    expect(handle.install).toHaveBeenCalledTimes(1)
    expect(updater.relaunch).not.toHaveBeenCalled()
  })

  it("ignores install outside the readyToInstall state", async () => {
    const { deps, updater, handle } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)

    await reachDownloaded(coordinator)
    await coordinator.install()

    expect(handle.install).not.toHaveBeenCalled()
    expect(updater.relaunch).not.toHaveBeenCalled()
  })

  it("classifies and reports an install failure without relaunching", async () => {
    const boom = new Error("installer failed")
    const handle = makeHandle({ install: vi.fn().mockRejectedValue(boom) })
    const { deps, updater } = makeEnv({ classifyError: vi.fn().mockReturnValue("install") })
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    await coordinator.requestInstall()
    await coordinator.install()

    expect(deps.classifyError).toHaveBeenCalledWith(boom, "install")
    expect(deps.reportManualFailure).toHaveBeenCalledWith("install")
    expect(updater.relaunch).not.toHaveBeenCalled()
    expect(last(states)).toEqual({
      kind: "failed",
      stage: "install",
      failure: "install",
      retryable: false,
    })
  })

  it("closes the previous handle when a newer check replaces it", async () => {
    const first = makeHandle()
    const second = makeHandle()
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.check("manual")

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
  })

  it("releases the retained handle when a later check finds no update", async () => {
    const handle = makeHandle()
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle).mockResolvedValueOnce(null)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.check("manual")

    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it("closes the retained handle on dispose even when close rejects", async () => {
    const handle = makeHandle({ close: vi.fn().mockRejectedValue(new Error("close failed")) })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    coordinator.dispose()

    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it("suppresses late publications from an in-flight check after disposal", async () => {
    const lateHandle = makeHandle()
    const { deps, resolveCheck } = deferredCheck()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    const pending = coordinator.check("manual")
    const lengthBeforeDisposal = states.length
    coordinator.dispose()
    resolveCheck(lateHandle)
    await pending

    expect(states.length).toBe(lengthBeforeDisposal)
    // the found handle is closed rather than retained after disposal
    expect(lateHandle.close).toHaveBeenCalledTimes(1)
  })

  it("suppresses late download completion after disposal", async () => {
    let finishDownload: () => void = () => {}
    const handle = makeHandle({
      download: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
      ),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    const pending = coordinator.download()
    const lengthBeforeDisposal = states.length
    coordinator.dispose()
    finishDownload()
    await pending

    expect(states.length).toBe(lengthBeforeDisposal)
  })

  it("treats operations after disposal as no-ops", async () => {
    const { deps, updater, handle } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)

    coordinator.dispose()
    await coordinator.check("manual")

    expect(updater.check).not.toHaveBeenCalled()
    expect(handle.close).not.toHaveBeenCalled()
  })

  it("dismisses back to idle from available", async () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    coordinator.dismiss()

    expect(last(states)).toEqual({ kind: "idle" })
  })

  it("hiding during download does not cancel it and still reports completion", async () => {
    let finishDownload: () => void = () => {}
    const handle = makeHandle({
      download: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
      ),
    })
    const { deps, updater } = makeEnv()
    updater.check.mockResolvedValueOnce(handle)
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await coordinator.check("manual")
    const pending = coordinator.download()
    coordinator.dismiss()
    expect(last(states)).toEqual({ kind: "idle" })

    finishDownload()
    await pending
    expect(last(states)).toEqual({ kind: "downloaded", update: UPDATE })
  })

  it("dismisses back to idle from downloaded", async () => {
    const { deps } = makeEnv()
    const coordinator = createUpdateCoordinator(deps)
    const { states } = collect(coordinator)

    await reachDownloaded(coordinator)
    coordinator.dismiss()

    expect(last(states)).toEqual({ kind: "idle" })
  })
})
