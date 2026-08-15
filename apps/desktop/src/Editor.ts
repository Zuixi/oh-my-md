import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine, type ViewUpdate } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import {
  collectOutline,
  editorExtensions,
  headingPositionForAnchor,
  getPendingOrderedListNormalization,
  isLivePreview,
  linkAt,
  type OrderedListNormalizationNotice,
  type OutlineItem,
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

export interface CreateEditorOptions {
  doc: string
  tabId: number
  documentId: number
  getDocPath: () => string | null
  getDocumentId: () => number
  onDocumentUpdate: (update: EditorDocumentUpdate) => void
  onError: (message: string) => void
  tabSize?: number
}

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

export function activateLink(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0) return false
  const target = event.target instanceof Element ? event.target.closest(".omd-link") : null
  if (!target) return false
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return false
  const targetLink = linkAt(view.state, pos)
  if (!targetLink) return false

  event.preventDefault()
  if (targetLink.href.startsWith("#")) {
    const target = headingPositionForAnchor(view.state, targetLink.href)
    if (target !== null) view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
  } else {
    window.open(targetLink.href, "_blank", "noopener,noreferrer")
  }
  return true
}

function samePending(
  a: OrderedListNormalizationNotice | null,
  b: OrderedListNormalizationNotice | null,
): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.markerCount === b.markerCount
}

function reportEditorUpdate(options: CreateEditorOptions, update: ViewUpdate): void {
  const pending = getPendingOrderedListNormalization(update.state)
  const before = getPendingOrderedListNormalization(update.startState)
  if (!update.docChanged && samePending(before, pending)) return
  options.onDocumentUpdate({
    tabId: options.tabId,
    documentId: options.documentId,
    doc: update.state.doc.toString(),
    docChanged: update.docChanged,
    pendingNormalization: pending,
  })
}

function createEditorState(options: CreateEditorOptions): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      EditorView.lineWrapping,
      options.tabSize ? EditorState.tabSize.of(options.tabSize) : [],
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
      EditorView.domEventHandlers({
        click: (event, view) => activateLink(view, event),
      }),
      EditorView.updateListener.of((update) => reportEditorUpdate(options, update)),
      EditorView.theme({
        "&": { height: "100%", fontSize: "15px" },
        ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
        ".cm-content": {
          padding: "16px 24px",
          maxWidth: "var(--omd-content-width, 780px)",
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

export interface EditorStatus {
  readonly cursor: string
  readonly mode: "live" | "source"
}

const NO_STATUS: EditorStatus = { cursor: "1:1", mode: "live" }

/** Chrome values read back from a view; test doubles are tolerated as "no status yet". */
export function editorStatus(view: EditorView | null): EditorStatus {
  if (!view) return NO_STATUS
  try {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    return {
      cursor: `${line.number}:${head - line.from + 1}`,
      mode: view.state.field(isLivePreview) ? "live" : "source",
    }
  } catch {
    return NO_STATUS
  }
}

export function documentOutline(view: EditorView | null): OutlineItem[] {
  try {
    return view ? collectOutline(view.state) : []
  } catch {
    return []
  }
}

export function resetEditorDocument(
  view: EditorView,
  options: CreateEditorOptions,
): void {
  view.setState(createEditorState(options))
}
