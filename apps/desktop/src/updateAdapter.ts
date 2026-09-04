import type { DownloadEvent } from "@tauri-apps/plugin-updater"

/**
 * Narrow wrapper around the official Tauri updater and process plugins.
 *
 * `check()` and `relaunch()` dynamically import the official plugins so
 * browser tests (which mock those modules) never require Tauri IPC. The raw
 * plugin `Update` handle stays private to the adapter: React state and the
 * coordinator only ever see the mapped {@link AdapterUpdate} projection.
 *
 * The plugin download events map 1:1:
 * - `Started.data.contentLength` -> `{ kind: "started", total }`
 * - `Progress.data.chunkLength` -> `{ kind: "progress", chunkLength }`
 * - `Finished` -> `{ kind: "finished" }`
 *
 * Cumulative progress accounting is coordinator-owned; this adapter only
 * forwards chunk deltas.
 */

export type AdapterDownloadEvent =
  | { readonly kind: "started"; readonly total?: number }
  | { readonly kind: "progress"; readonly chunkLength: number }
  | { readonly kind: "finished" }

export interface AdapterUpdate {
  readonly currentVersion: string
  readonly version: string
  readonly notes: string
  readonly publishedAt?: string
  download(onEvent: (event: AdapterDownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export interface UpdateAdapter {
  check(): Promise<AdapterUpdate | null>
  relaunch(): Promise<void>
}

export function createTauriUpdateAdapter(): UpdateAdapter {
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (update === null) {
        return null
      }
      return {
        currentVersion: update.currentVersion,
        version: update.version,
        notes: update.body ?? "",
        publishedAt: update.date,
        download(onEvent: (event: AdapterDownloadEvent) => void): Promise<void> {
          return update.download((progress: DownloadEvent) => {
            switch (progress.event) {
              case "Started":
                onEvent({ kind: "started", total: progress.data.contentLength })
                break
              case "Progress":
                onEvent({ kind: "progress", chunkLength: progress.data.chunkLength })
                break
              case "Finished":
                onEvent({ kind: "finished" })
                break
            }
          })
        },
        install: () => update.install(),
        close: () => update.close(),
      }
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    },
  }
}