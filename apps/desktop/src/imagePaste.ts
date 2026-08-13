import { invoke } from "@tauri-apps/api/core"
import { EditorView } from "@codemirror/view"

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
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
  writeImage?: (path: string, base64: string, documentPath: string) => Promise<void>
}

const defaultWriteImage = async (path: string, base64: string, documentPath: string) => {
  await invoke("write_image", { path, base64, documentPath })
}

export function imagePasteHandler(options: ImagePasteOptions) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = Array.from(event.clipboardData?.items ?? [])
      const item = items.find(i => i.type.startsWith("image/"))
      if (!item) return false
      event.preventDefault()
      const file = item.getAsFile()
      if (!file) return true
      void pasteImage(file, view, options, item.type)
      return true
    },
  })
}

export async function pasteImage(
  file: File,
  view: EditorView,
  options: ImagePasteOptions,
  clipboardMime = file.type,
): Promise<void> {
  const docPath = options.getDocPath()
  if (!docPath) {
    options.onError("Save the file before pasting an image")
    return
  }

  const mime = file.type || clipboardMime
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
  const selection = view.state.selection.main
  const normalizedPath = docPath.replace(/\\/g, "/")
  const dir = normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
  const id = crypto.randomUUID()
  const name = `pasted-${id}.${extension}`
  const relativePath = `assets/${name}`

  const isCurrentDocument = () =>
    options.getDocPath() === docPath &&
    options.getDocumentId() === documentId &&
    view.state.doc === document

  const previous = pasteQueues.get(view) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    try {
      const base64 = await (options.readFile ?? fileToBase64)(file)
      if (!isCurrentDocument()) {
        options.onError("Document changed before the image could be pasted")
        return
      }
      await (options.writeImage ?? defaultWriteImage)(
        `${dir}${relativePath}`,
        base64,
        docPath,
      )

      if (!isCurrentDocument()) {
        options.onError(
          "Document changed after the image was saved; reference was not inserted",
        )
        return
      }

      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: `![](${relativePath})`,
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      options.onError(`Image paste failed: ${detail}`)
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      if (typeof r.result !== "string") {
        reject(new Error("FileReader returned no data"))
        return
      }
      const separator = r.result.indexOf(",")
      if (separator < 0) {
        reject(new Error("FileReader returned invalid data"))
        return
      }
      resolve(r.result.slice(separator + 1))
    }
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"))
    r.readAsDataURL(file)
  })
}
