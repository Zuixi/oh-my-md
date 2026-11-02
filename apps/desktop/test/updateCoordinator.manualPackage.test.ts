import { describe, expect, it, vi } from "vitest"
import {
  createUpdateCoordinator,
  type AvailableUpdate,
  type UpdateCoordinatorDependencies,
} from "../src/updateCoordinator"
import type { PrepareUpdateRestartResult } from "../src/desktopServices"
import type { AdapterUpdate, UpdateAdapter } from "../src/updateAdapter"

/**
 * Check-only installs (former MSI, deb/rpm Linux) can never download through
 * the updater: `download()` deep-links the versioned NSIS setup asset and
 * falls back to the generic Release page. Split from updateCoordinator.test.ts
 * to respect the module-size gate.
 */
const UPDATE: AvailableUpdate = {
  version: "0.1.1",
  notes: "Bug fixes and polish.",
  publishedAt: "2026-09-10T10:00:00Z",
}

function makeEnv(overrides: Partial<UpdateCoordinatorDependencies> = {}) {
  const handle = {
    currentVersion: "0.0.1",
    version: "0.1.1",
    notes: "Bug fixes and polish.",
    publishedAt: "2026-09-10T10:00:00Z",
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const updater = {
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
    openManualDownload: vi.fn().mockResolvedValue(undefined),
    reportManualFailure: vi.fn(),
    logFailure: vi.fn(),
    notifyLatest: vi.fn(),
    isWindows: vi.fn().mockReturnValue(false),
    classifyError: vi.fn().mockReturnValue("unknown"),
    ...overrides,
  }
  return { deps, handle: handle as AdapterUpdate & { download: ReturnType<typeof vi.fn> }, updater }
}

function lastState(coordinator: ReturnType<typeof createUpdateCoordinator>) {
  const states: Parameters<Parameters<typeof coordinator.subscribe>[0]>[0][] = []
  const unsubscribe = coordinator.subscribe((state) => states.push(state))
  unsubscribe()
  return states[states.length - 1]
}

describe("updateCoordinator check-only (manual package) downloads", () => {
  it("publishes available with installSupported false", async () => {
    const { deps } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: true, install: false, reason: "manualPackage" }),
    })
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")

    expect(lastState(coordinator)).toEqual({
      kind: "available",
      installSupported: false,
      update: UPDATE,
    })
  })

  it("deep-links the versioned installer instead of downloading", async () => {
    const { deps, handle } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: true, install: false, reason: "manualPackage" }),
    })
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.download()

    expect(deps.openManualDownload).toHaveBeenCalledTimes(1)
    expect(deps.openManualDownload).toHaveBeenCalledWith(UPDATE.version)
    expect(deps.openReleasePage).not.toHaveBeenCalled()
    expect(handle.download).not.toHaveBeenCalled()
    expect(lastState(coordinator)).toEqual({
      kind: "available",
      installSupported: false,
      update: UPDATE,
    })
  })

  it("falls back to the Release page when the installer deep-link fails", async () => {
    const { deps } = makeEnv({
      capability: vi.fn().mockResolvedValue({ check: true, install: false, reason: "manualPackage" }),
      openManualDownload: vi.fn().mockRejectedValue(new Error("open failed")),
    })
    const coordinator = createUpdateCoordinator(deps)

    await coordinator.check("manual")
    await coordinator.download()

    expect(deps.openManualDownload).toHaveBeenCalledTimes(1)
    expect(deps.openReleasePage).toHaveBeenCalledTimes(1)
  })
})
