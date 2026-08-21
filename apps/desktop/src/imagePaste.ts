import { invoke } from "@tauri-apps/api/core"
import { EditorView } from "@codemirror/view"
import { ASSETS_DIR_NAME, MAX_IMAGE_BYTES } from "./constants"
import { isWindows } from "./platform"

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
  writeImage?: (path: string, base64: string, documentPath: string) => Promise<void>
}

const defaultWriteImage = async (path: string, base64: string, documentPath: string) => {
  await invoke("write_image", { path, base64, documentPath })
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
  // Saved paste target from the most recent right-click contextmenu event.
  // On macOS WebKit, right-click fires selectionchange before contextmenu,
  // which causes CM to call skipAtomsForSelection and potentially expand the
  // CM selection to cover 2 or more lines.  By the time "paste" fires the
  // expanded selection is baked into CM state, so CM's own doPaste replaces
  // those lines instead of inserting at the cursor (bug: 2 lines disappear).
  //
  // We work around this by capturing the right-click coordinates in the
  // contextmenu handler and converting them to a CM document position via
  // posAtCoords — pixel coordinates are independent of native-selection state
  // so we get the true click position even after the corruption has occurred.
  // The paste handler then uses that position for text paste and returns true,
  // preventing CM's corrupted-selection handler from running at all.
  //
  // Keyboard paste (Ctrl/Cmd-V) is unaffected: contextMenuTarget stays null
  // and we fall through to CM's default handler unchanged.
  let contextMenuTarget: { from: number; to: number } | null = null

  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      const clickPos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (clickPos !== null) {
        // If the user right-clicked inside an existing non-empty selection,
        // preserve that selection so paste can replace it as expected.
        const sel = view.state.selection.main
        if (!sel.empty && clickPos >= sel.from && clickPos <= sel.to) {
          contextMenuTarget = { from: sel.from, to: sel.to }
        } else {
          // Otherwise use the click point as a collapsed cursor.
          contextMenuTarget = { from: clickPos, to: clickPos }
          // The selectionchange dispatch works around a WKWebView bug (WebKit-family
          // engines only); WebView2 is Chromium and must keep native caret behavior.
          if (!isWindows()) {
            view.dispatch({ selection: { anchor: clickPos } })
          }
        }
      } else {
        contextMenuTarget = null
      }
      return false
    },

    paste(event, view) {
      const items = Array.from(event.clipboardData?.items ?? [])
      const imageItem = items.find(i => i.type.startsWith("image/"))

      if (imageItem) {
        // Image paste: same as before; clear contextMenuTarget and delegate to
        // pasteImage which captures the selection itself.
        event.preventDefault()
        contextMenuTarget = null
        const file = imageItem.getAsFile()
        if (!file) return true
        void pasteImage(file, view, options, imageItem.type)
        return true
      }

      // Text paste via context menu: bypass CM's doPaste entirely so it never
      // uses the WebKit-corrupted selection.
      const savedTarget = contextMenuTarget
      contextMenuTarget = null

      if (savedTarget !== null) {
        const text =
          event.clipboardData?.getData("text/plain") ||
          event.clipboardData?.getData("text/uri-list") ||
          ""
        if (text) {
          event.preventDefault()
          view.dispatch({
            changes: { from: savedTarget.from, to: savedTarget.to, insert: text },
            userEvent: "input.paste",
            scrollIntoView: true,
          })
          return true
        }
      }

      // Keyboard paste (no contextmenu): fall through to CM's default handler.
      return false
    },

    drop(event, view) {
      return handleImageDrop(event, view, options)
    },
  })
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
  const normalizedPath = docPath.replace(/\\/g, "/")
  const dir = normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
  const id = crypto.randomUUID()
  const name = `pasted-${id}.${extension}`
  const relativePath = `${ASSETS_DIR_NAME}/${name}`

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
