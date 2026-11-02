import {
  commitPasteAssets,
  discardPasteAssets,
  writePasteAssets,
} from "./desktopServices"

export interface PasteAssetWrite {
  readonly key: string
  readonly mime: string
  readonly base64: string
}

export interface PasteAssetResult {
  readonly key: string
  readonly relativePath: string
}

export interface PasteAssetFailure {
  readonly key: string
  readonly kind: "unsupportedMime" | "invalidData" | "tooLarge"
}

export interface PasteAssetBatch {
  readonly batchId: string | null
  readonly items: readonly PasteAssetResult[]
  readonly failures: readonly PasteAssetFailure[]
}

export interface PasteAssetStore {
  write(documentPath: string, assets: readonly PasteAssetWrite[]): Promise<PasteAssetBatch>
  commit(batchId: string): Promise<void>
  discard(batchId: string): Promise<void>
}

export const nativePasteAssetStore: PasteAssetStore = {
  write: writePasteAssets,
  commit: commitPasteAssets,
  discard: discardPasteAssets,
}

export function fileToPasteAsset(file: File, key: string): Promise<PasteAssetWrite> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("FileReader returned no data"))
        return
      }
      const separator = reader.result.indexOf(",")
      if (separator < 0) {
        reject(new Error("FileReader returned invalid data"))
        return
      }
      resolve({ key, mime: file.type, base64: reader.result.slice(separator + 1) })
    }
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"))
    reader.readAsDataURL(file)
  })
}
