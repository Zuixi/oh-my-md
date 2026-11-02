import { EditorView } from "@codemirror/view"
import { MAX_IMAGE_BYTES } from "./constants"
import {
  fileToPasteAsset,
  nativePasteAssetStore,
  type PasteAssetStore,
} from "./pasteAssets"

const ACCEPTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}
const pasteQueues = new WeakMap<EditorView, Promise<void>>()

export interface ImagePasteOptions {
  getDocPath: () => string | null
  getDocumentId: () => number
  onError: (message: string) => void
  readFile?: (file: File) => Promise<string>
  assetStore?: PasteAssetStore
}

function defaultPickImage(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ACCEPTED_IMAGE_MIMES.join(",")
    input.hidden = true
    let settled = false

    const cleanup = () => {
      input.removeEventListener("change", handleChange)
      input.removeEventListener("cancel", handleCancel)
      window.removeEventListener("focus", handleWindowFocus)
      input.remove()
    }

    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(file)
    }

    const handleChange = () => finish(input.files?.[0] ?? null)
    const handleCancel = () => finish(null)
    const handleWindowFocus = () => {
      window.setTimeout(() => finish(input.files?.[0] ?? null), 0)
    }

    input.addEventListener("change", handleChange, { once: true })
    input.addEventListener("cancel", handleCancel, { once: true })
    window.addEventListener("focus", handleWindowFocus, { once: true })
    ;(document.body ?? document.documentElement).append(input)
    input.click()
  })
}

function droppedImageFile(event: DragEvent): File | null {
  const files = Array.from(event.dataTransfer?.files ?? [])
  return files.find(file => file.type in EXTENSION_BY_MIME) ?? null
}

export function imagePasteHandler(options: ImagePasteOptions) {
  return [
    EditorView.domEventHandlers({
      drop(event, view) {
        return handleImageDrop(event, view, options)
      },
    }),
  ]
}

export function handleImageDrop(
  event: DragEvent,
  view: EditorView,
  options: ImagePasteOptions,
): boolean {
  const file = droppedImageFile(event)
  if (!file) return false

  event.preventDefault()
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  const range = pos === null ? undefined : { from: pos, to: pos }
  void insertImageFile(file, view, options, file.type, range)
  return true
}

export async function insertImageFile(
  file: File,
  view: EditorView,
  options: ImagePasteOptions,
  mime: string,
  range?: { from: number; to: number },
): Promise<void> {
  // readOnly 是建议性 facet：drop/paste 的 domEventHandlers 先于 CM 内建的
  // readOnly 分支运行（first-true-wins），命令路径更无从拦截 —— 统一挡在
  // 读文件/写资产之前，只读文档既不插入引用也不落盘图片资产。
  if (view.state.readOnly) return
  const docPath = options.getDocPath()
  if (!docPath) {
    options.onError("Save the file before inserting an image")
    return
  }

  const extension = EXTENSION_BY_MIME[mime]
  if (!extension) {
    options.onError(`Unsupported image type: ${mime || "unknown"}`)
    return
  }
  if (file.size > MAX_IMAGE_BYTES) {
    options.onError("Image is too large (maximum 10 MiB)")
    return
  }

  const documentId = options.getDocumentId()
  const document = view.state.doc
  const selection = range ?? view.state.selection.main
  const id = crypto.randomUUID()

  const isCurrentDocument = () =>
    options.getDocPath() === docPath &&
    options.getDocumentId() === documentId &&
    view.state.doc === document

  const previous = pasteQueues.get(view) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    try {
      const base64 = await (options.readFile ?? fileToBase64)(file)
      if (!isCurrentDocument()) {
        options.onError("Document changed before the image could be inserted")
        return
      }
      let batchId: string | null = null
      let persistedPath: string
      const store = options.assetStore ?? nativePasteAssetStore
      const batch = await store.write(docPath, [{
        key: id,
        mime,
        base64,
      }])
      batchId = batch.batchId
      const result = batch.items[0]
      if (!result) {
        const failure = batch.failures[0]?.kind ?? "invalidData"
        options.onError(`Image insert failed: ${failure}`)
        return
      }
      persistedPath = result.relativePath

      if (!isCurrentDocument()) {
        if (batchId) await (options.assetStore ?? nativePasteAssetStore).discard(batchId)
        options.onError(
          "Document changed after the image was saved; reference was not inserted",
        )
        return
      }

      const markdown = `![](${persistedPath})`
      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: markdown,
        },
        // Explicit selection: without one the cursor stays before the
        // inserted image markdown instead of after it (CM maps the old
        // cursor through the change with assoc -1).
        selection: { anchor: selection.from + markdown.length },
        scrollIntoView: true,
      })
      if (batchId) {
        try {
          await (options.assetStore ?? nativePasteAssetStore).commit(batchId)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          options.onError(`Image inserted but asset cleanup metadata failed: ${detail}`)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      options.onError(`Image insert failed: ${detail}`)
    }
  })
  pasteQueues.set(view, operation)

  try {
    await operation
  } finally {
    if (pasteQueues.get(view) === operation) {
      pasteQueues.delete(view)
    }
  }
}

export function pasteImage(
  file: File,
  view: EditorView,
  options: ImagePasteOptions,
  clipboardMime = file.type,
): Promise<void> {
  return insertImageFile(file, view, options, file.type || clipboardMime)
}

export async function pickAndInsertImage(
  view: EditorView,
  options: ImagePasteOptions,
  pick: () => Promise<File | null> = defaultPickImage,
): Promise<void> {
  // 只读文档连文件选择器都不开（insertImageFile 兜底还会再拦一次）。
  if (view.state.readOnly) return
  const docPath = options.getDocPath()
  if (!docPath) {
    options.onError("Save the file before inserting an image")
    return
  }
  const documentId = options.getDocumentId()
  const document = view.state.doc
  const selection = view.state.selection.main
  const file = await pick()
  if (!file) return
  if (
    options.getDocPath() !== docPath ||
    options.getDocumentId() !== documentId ||
    view.state.doc !== document
  ) {
    options.onError("Document changed before the image could be inserted")
    return
  }
  await insertImageFile(file, view, options, file.type, selection)
}

async function fileToBase64(file: File): Promise<string> {
  return (await fileToPasteAsset(file, "image")).base64
}
