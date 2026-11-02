import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  inVerbatim,
  planSmartPaste,
  preparePlainTextFallback,
  prepareSmartPaste,
  type SmartPastePlan,
} from "@omd/engine"
import {
  payloadFromDataTransfer,
  readClipboardPayload,
  systemClipboardReader,
  type ClipboardPayload,
  type SystemClipboardReader,
} from "./clipboardPayload"
import type { ImagePasteOptions } from "./imagePaste"
import { fileToPasteAsset, nativePasteAssetStore } from "./pasteAssets"
import { runPasteJob, type PasteJobOptions, type PasteJobTarget } from "./pasteJob"
import { isWindows } from "./platform"
import { t } from "./i18n"
import { SMART_PASTE_STATUS_CHARS } from "./constants"

export type ClipboardPasteOptions = ImagePasteOptions & PasteJobOptions & {
  readonly onNotice: (message: string) => void
  readonly onConvertingChange: (active: boolean) => void
}

export function clipboardPasteExtension(options: ClipboardPasteOptions): Extension {
  let contextMenuTarget: { from: number; to: number } | null = null
  return [
    EditorView.updateListener.of(update => {
      if (!contextMenuTarget || !update.selectionSet) return
      const selection = update.state.selection.main
      if (selection.from !== contextMenuTarget.from || selection.to !== contextMenuTarget.to) {
        contextMenuTarget = null
      }
    }),
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) {
          contextMenuTarget = null
          return false
        }
        const selection = view.state.selection.main
        contextMenuTarget = !selection.empty && pos >= selection.from && pos <= selection.to
          ? { from: selection.from, to: selection.to }
          : { from: pos, to: pos }
        if (!isWindows()) view.dispatch({ selection: { anchor: contextMenuTarget.from, head: contextMenuTarget.to } })
        return false
      },
      paste(event, view) {
        if (view.state.readOnly) {
          contextMenuTarget = null
          return true
        }
        const transfer = event.clipboardData
        if (!transfer) return false
        const payload = payloadFromDataTransfer(transfer)
        const savedTarget = contextMenuTarget
        contextMenuTarget = null
        if (savedTarget) view.dispatch({ selection: { anchor: savedTarget.from, head: savedTarget.to } })
        const guardedPlain = shouldUsePlainText(view)
        if (!payload.html && payload.images.length === 0 && !guardedPlain) return false
        if (view.state.selection.ranges.length > 1 && savedTarget === null) return false

        event.preventDefault()
        void runClipboardPayload(view, payload, options, guardedPlain)
        return true
      },
    }),
  ]
}

export function pasteFromSystemClipboard(
  view: EditorView,
  reader: SystemClipboardReader = systemClipboardReader,
  options: ClipboardPasteOptions,
): Promise<void> {
  return runPasteJob(view, options, () => readClipboardPayload(reader), async (payload, currentTarget) => {
    await applyPayload(view, payload, options, currentTarget, false)
  })
}

function runClipboardPayload(
  view: EditorView,
  payload: ClipboardPayload,
  options: ClipboardPasteOptions,
  forcePlain: boolean,
): Promise<void> {
  return runPasteJob(view, options, async () => payload, async (current, currentTarget) => {
    await applyPayload(view, current, options, currentTarget, forcePlain)
  })
}

async function applyPayload(
  view: EditorView,
  payload: ClipboardPayload,
  options: ClipboardPasteOptions,
  currentTarget: () => PasteJobTarget,
  forcePlain: boolean,
): Promise<void> {
  const target = currentTarget()
  if (target.kind !== "active") return

  if (forcePlain || target.ranges.length > 1 || !payload.html) {
    if (!payload.html && payload.images.length > 0 && target.ranges.length === 1) {
      await pasteClipboardImages(view, payload.images, options, currentTarget)
      return
    }
    dispatchText(view, target, payload.plainText)
    return
  }

  for (const diagnostic of payload.diagnostics) {
    options.onNotice(diagnostic === "richReadFailed"
      ? t("paste.notice.richUnavailable")
      : t("paste.notice.flavorUnavailable"))
  }

  let plan: SmartPastePlan | null = null
  let batchId: string | null = null
  const store = options.assetStore ?? nativePasteAssetStore
  const showConverting = payload.html.length >= SMART_PASTE_STATUS_CHARS
  if (showConverting) {
    options.onConvertingChange(true)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  try {
    let prepared: ReturnType<typeof prepareSmartPaste> | null = null
    try {
      prepared = prepareSmartPaste({ html: payload.html, plainText: payload.plainText })
    } catch {
      plan = planSmartPaste(
        preparePlainTextFallback(payload.plainText),
        view.state,
        target.ranges[0],
      )
      options.onNotice(t("paste.notice.literalFallback"))
    }
    if (prepared) {
      const assets = new Map<string, string>()
      if (prepared.assets.length > 0) {
        const documentPath = options.getDocPath()
        const beforeWrite = currentTarget()
        if (documentPath && beforeWrite.kind === "active") {
          const batch = await store.write(documentPath, prepared.assets.map(asset => ({
            key: asset.key,
            mime: asset.mime,
            base64: asset.base64,
          })))
          batchId = batch.batchId
          for (const item of batch.items) assets.set(item.key, item.relativePath)
          if (batch.failures.length > 0) {
            options.onNotice(t("paste.notice.partialImages"))
          }
        } else {
          options.onNotice(t("paste.notice.saveBeforeImages"))
        }
      }
      const beforePlan = currentTarget()
      if (beforePlan.kind !== "active" || beforePlan.ranges.length !== 1) {
        if (batchId) await store.discard(batchId)
        return
      }
      plan = planSmartPaste(prepared, view.state, beforePlan.ranges[0], assets)
    }
  } finally {
    if (showConverting) options.onConvertingChange(false)
  }
  if (!plan) return

  const fresh = currentTarget()
  if (fresh.kind !== "active" || fresh.ranges.length !== 1) {
    if (batchId) await store.discard(batchId)
    return
  }
  try {
    dispatchPlan(view, fresh.ranges[0], plan)
  } catch (error) {
    if (batchId) await store.discard(batchId)
    throw error
  }
  if (batchId) {
    try {
      await store.commit(batchId)
    } catch {
      options.onNotice(t("paste.notice.commitUnconfirmed"))
    }
  }
  if (plan.diagnostics.some(item => item.kind === "unsupportedTable")) {
    options.onNotice(t("paste.notice.tableSimplified"))
  }
  if (plan.diagnostics.some(item => item.kind === "unresolvedAsset")) {
    options.onNotice(t("paste.notice.partialImages"))
  }
}

async function pasteClipboardImages(
  view: EditorView,
  files: readonly File[],
  options: ClipboardPasteOptions,
  currentTarget: () => PasteJobTarget,
): Promise<void> {
  const documentPath = options.getDocPath()
  if (!documentPath) {
    options.onError("Save the file before inserting an image")
    return
  }
  const assets = await Promise.all(files.map((file, index) =>
    fileToPasteAsset(file, `clipboard-image-${index}`)))
  const beforeWrite = currentTarget()
  if (beforeWrite.kind !== "active" || beforeWrite.ranges.length !== 1) return
  const store = options.assetStore ?? nativePasteAssetStore
  const batch = await store.write(documentPath, assets)
  const fresh = currentTarget()
  if (fresh.kind !== "active" || fresh.ranges.length !== 1) {
    if (batch.batchId) await store.discard(batch.batchId)
    return
  }
  const text = batch.items.map(item => `![](${item.relativePath})`).join("\n\n")
  if (text) dispatchText(view, fresh, text)
  if (batch.batchId) {
    try {
      await store.commit(batch.batchId)
    } catch {
      options.onNotice(t("paste.notice.commitUnconfirmed"))
    }
  }
  if (batch.failures.length > 0) {
    options.onNotice(t("paste.notice.partialImages"))
  }
}

function shouldUsePlainText(view: EditorView): boolean {
  return view.state.selection.ranges.some(range =>
    inVerbatim(view.state, range.from) ||
    (!range.empty && inVerbatim(view.state, range.to - 1)))
}

function dispatchText(view: EditorView, target: Extract<PasteJobTarget, { kind: "active" }>, text: string): void {
  if (!text) return
  const changes = target.ranges.map(range => ({ from: range.from, to: range.to, insert: text }))
  view.dispatch({
    changes,
    selection: { anchor: changes[changes.length - 1].from + text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  })
}

function dispatchPlan(view: EditorView, range: { readonly from: number; readonly to: number }, plan: SmartPastePlan): void {
  if (!plan.text) return
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: plan.text },
    selection: { anchor: range.from + plan.text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  })
}
