import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine, type ViewUpdate } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import {
  editorExtensions,
  getPendingOrderedListNormalization,
  type OrderedListNormalizationNotice,
} from "@omd/engine"
import { imagePasteHandler } from "./imagePaste"
import { typewriterExtension } from "./typewriter"
import { convertFileSrc } from "@tauri-apps/api/core"

/**
 * One editor update reported to the host, stamped with the identity the editor was built for.
 * A reset or a reopen creates a new binding, so a stale callback can be recognized instead of
 * writing into whatever document happens to be active when it arrives.
 */
export interface EditorDocumentUpdate {
  readonly tabId: number
  readonly documentId: number
  readonly doc: string
  readonly docChanged: boolean
  readonly pendingNormalization: OrderedListNormalizationNotice | null
}

interface EditorHostOptions {
  doc: string
  getDocPath: () => string | null
  getDocumentId: () => number
  onError: (message: string) => void
}

export interface BoundEditorOptions extends EditorHostOptions {
  tabId: number
  documentId: number
  onDocumentUpdate: (update: EditorDocumentUpdate) => void
  onDocChanged?: undefined
}

/**
 * Temporary shape for hosts that have not bound identity yet. Delete this variant, and the
 * legacy branch in `notifyHost`, once every caller passes `BoundEditorOptions`.
 */
export interface LegacyEditorOptions extends EditorHostOptions {
  onDocChanged: (doc: string) => void
  tabId?: undefined
  documentId?: undefined
  onDocumentUpdate?: undefined
}

export type CreateEditorOptions = BoundEditorOptions | LegacyEditorOptions

export function makeImageResolver(
  getDocPath: () => string | null,
  convert: (path: string) => string = convertFileSrc,
) {
  return (src: string) => {
    if (/^(https?:|data:|asset:)/i.test(src)) return src
    const docPath = getDocPath()
    if (!docPath) return src
    const normalizedPath = docPath.replace(/\\/g, "/")
    const dir = normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
    return convert(dir + src)
  }
}

function samePending(
  a: OrderedListNormalizationNotice | null,
  b: OrderedListNormalizationNotice | null,
): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.markerCount === b.markerCount
}

function notifyHost(
  options: CreateEditorOptions,
  update: ViewUpdate,
  pendingNormalization: OrderedListNormalizationNotice | null,
): void {
  const doc = update.state.doc.toString()
  if (options.onDocumentUpdate) {
    options.onDocumentUpdate({
      tabId: options.tabId,
      documentId: options.documentId,
      doc,
      docChanged: update.docChanged,
      pendingNormalization,
    })
    return
  }
  if (update.docChanged) options.onDocChanged(doc)
}

function reportEditorUpdate(options: CreateEditorOptions, update: ViewUpdate): void {
  const pending = getPendingOrderedListNormalization(update.state)
  const before = getPendingOrderedListNormalization(update.startState)
  if (!update.docChanged && samePending(before, pending)) return
  notifyHost(options, update, pending)
}

function createEditorState(options: CreateEditorOptions): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      editorExtensions({
        resolveImageSrc: makeImageResolver(options.getDocPath),
      }),
      typewriterExtension(),
      imagePasteHandler({
        getDocPath: options.getDocPath,
        getDocumentId: options.getDocumentId,
        onError: options.onError,
      }),
      EditorView.updateListener.of((update) => reportEditorUpdate(options, update)),
      EditorView.theme({
        "&": { height: "100%", fontSize: "15px" },
        ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
        ".cm-content": {
          padding: "16px 24px",
          maxWidth: "780px",
          margin: "0 auto",
        },
      }),
    ],
  })
}

export function createEditor(
  parent: HTMLElement,
  options: CreateEditorOptions,
): EditorView {
  return new EditorView({
    state: createEditorState(options),
    parent,
  })
}

export function resetEditorDocument(
  view: EditorView,
  options: CreateEditorOptions,
): void {
  view.setState(createEditorState(options))
}
