import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine, type ViewUpdate } from "@codemirror/view"
import { Compartment, EditorState, Facet } from "@codemirror/state"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import {
  classifyLink,
  collectOutline,
  editorExtensions,
  footnoteAt,
  footnoteDefinitionPosition,
  headingPositionForAnchor,
  getPendingOrderedListNormalization,
  isLivePreview,
  linkAt,
  type OrderedListNormalizationNotice,
  type OutlineItem,
} from "@omd/engine"
import { imagePasteHandler } from "./imagePaste"
import { typewriterExtension } from "./typewriter"
import { CONTENT_MAX_WIDTH } from "./constants"
import { t } from "./i18n"
import { convertFileSrc } from "@tauri-apps/api/core"

/**
 * One editor update reported to the host, stamped with the identity the editor was built for.
 * A reset or a reopen creates a new binding, so a stale callback can be recognized instead of
 * writing into whatever document happens to be active when it arrives.
 */
export interface EditorDocumentUpdate {
  readonly tabId: number
  readonly documentId: number
  // Spec 05a：doc 字段已移除——每键物化整文档字符串（rope 展平 5-15ms @10MB + GC churn）
  // 是逐键路径上最大的 O(doc) 应用层工作。App 按物化节奏从 view.state.doc 拉取。
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
  onOpenMarkdownHref?: (href: string) => void
  tabSize?: number
  spellcheck?: boolean
  /** Spec 05b HUGE 档：只读（仍挂 Markdown 语言与实时预览，渐进渲染兜底大文档）。 */
  readOnly?: boolean
  /** Construct already in Source (no live decorations at create time). */
  defaultLivePreview?: boolean
  /** Notified when the live/source field flips, so the host can mirror it. */
  onModeChange?: (isLive: boolean) => void
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

const markdownHrefHandler = Facet.define<(href: string) => void>()
const lastFootnoteJump = new WeakMap<EditorView, { id: string; from: number }>()

function activateFootnote(view: EditorView, pos: number): boolean {
  const fn = footnoteAt(view.state, pos)
  if (!fn) return false
  if (fn.kind === "reference") {
    const dest = footnoteDefinitionPosition(view.state, fn.id)
    if (dest === null) return true
    lastFootnoteJump.set(view, { id: fn.id, from: fn.from })
    view.dispatch({ selection: { anchor: dest }, scrollIntoView: true })
    return true
  }
  const last = lastFootnoteJump.get(view)
  if (last && last.id.toLowerCase() === fn.id.toLowerCase()) {
    view.dispatch({ selection: { anchor: last.from }, scrollIntoView: true })
    lastFootnoteJump.delete(view)
  }
  return true
}

export function activateLink(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0) return false
  const el = event.target instanceof Element ? event.target : null
  const onFootnote = el?.closest(".omd-footnote, .omd-footnote-def")
  const onLink = el?.closest(".omd-link")
  if (!onFootnote && !onLink) return false
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return false

  if (onFootnote && activateFootnote(view, pos)) {
    event.preventDefault()
    return true
  }
  if (!onLink) return false

  const targetLink = linkAt(view.state, pos)
  if (!targetLink) return false

  event.preventDefault()
  if (targetLink.href.startsWith("#")) {
    const heading = headingPositionForAnchor(view.state, targetLink.href)
    if (heading !== null) view.dispatch({ selection: { anchor: heading }, scrollIntoView: true })
    return true
  }
  const classified = classifyLink(targetLink.href)
  if (classified.kind === "external") {
    window.open(classified.href, "_blank", "noopener,noreferrer")
  } else if (classified.kind === "markdown") {
    view.state.facet(markdownHrefHandler)[0]?.(classified.href)
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
    docChanged: update.docChanged,
    pendingNormalization: pending,
  })
}

function reportModeChange(options: CreateEditorOptions, update: ViewUpdate): void {
  if (!options.onModeChange) return
  const before = update.startState.field(isLivePreview)
  const after = update.state.field(isLivePreview)
  if (before !== after) options.onModeChange(after)
}

const spellcheckCompartment = new Compartment()

function spellcheckAttr(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" })
}

export function setEditorSpellcheck(view: EditorView, on: boolean): void {
  view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckAttr(on)) })
}

function createEditorState(options: CreateEditorOptions): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      EditorView.lineWrapping,
      spellcheckCompartment.of(spellcheckAttr(options.spellcheck === true)),
      options.tabSize ? EditorState.tabSize.of(options.tabSize) : [],
      options.readOnly ? EditorState.readOnly.of(true) : [],
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      editorExtensions({
        resolveImageSrc: makeImageResolver(options.getDocPath),
        imageBrokenLabel: (src: string) => t("image.broken", { src }),
        defaultLivePreview: options.defaultLivePreview,
      }),
      options.onOpenMarkdownHref ? markdownHrefHandler.of(options.onOpenMarkdownHref) : [],
      typewriterExtension(),
      imagePasteHandler({
        getDocPath: options.getDocPath,
        getDocumentId: options.getDocumentId,
        onError: options.onError,
      }),
      EditorView.domEventHandlers({
        click: (event, view) => activateLink(view, event),
      }),
      EditorView.updateListener.of((update) => {
        reportEditorUpdate(options, update)
        reportModeChange(options, update)
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "15px" },
        ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
        ".cm-content": {
          padding: "16px 24px",
          maxWidth: `var(--omd-content-width, ${CONTENT_MAX_WIDTH}px)`,
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
  lastFootnoteJump.delete(view)
  view.setState(createEditorState(options))
}
