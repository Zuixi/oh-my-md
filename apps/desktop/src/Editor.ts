import { EditorView, keymap, dropCursor, highlightActiveLine, type ViewUpdate } from "@codemirror/view"
import { Compartment, EditorState, Facet, type Text } from "@codemirror/state"
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
import { tightSelection } from "./tightSelection"
import { isMacOS } from "./platform"
import { CONTENT_MAX_WIDTH } from "./constants"
import { sameEditorStatus, type EditorStatus } from "./editorStatus"
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
  /**
   * Task 10：doc 直接收 Text（LARGE 档流式打开的 chunk 组装产物）时，
   * EditorState.create 跳过对整串的 regex 切行；字符串路径（常规读盘、会话恢复
   * 等无 docText 的调用方）行为不变。
   */
  doc: string | Text
  tabId: number
  documentId: number
  getDocPath: () => string | null
  getDocumentId: () => number
  onDocumentUpdate: (update: EditorDocumentUpdate) => void
  onError: (message: string) => void
  onOpenMarkdownHref?: (href: string) => void
  onOpenExternalHref?: (href: string) => void
  tabSize?: number
  spellcheck?: boolean
  /** Spec 05b HUGE 档：只读（仍挂 Markdown 语言与实时预览，渐进渲染兜底大文档）。 */
  readOnly?: boolean
  /** Construct already in Source (no live decorations at create time). */
  defaultLivePreview?: boolean
  /** Notified when the live/source mode flips, so the host can mirror it. */
  onModeChange?: (isLive: boolean) => void
  /** Notified on every update with a lightweight cursor/mode snapshot. */
  onStatusChange?: (status: EditorStatus) => void
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
const externalHrefHandler = Facet.define<(href: string) => void>()
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
  // Typora 语义（support.typora.io/Links）：普通左键=编辑（光标由 CM 原生
  // mousedown 放置，引擎 cursorInside 展开被点击的链接）；只有打开意图的
  // 修饰键点击才导航。macOS 的 Ctrl+Click 是右键（合成上下文菜单），打开
  // 意图在 darwin 上只认 ⌘；Windows/Linux 认 Ctrl。
  const openIntent = isMacOS() ? event.metaKey : event.ctrlKey
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) return false

  if (onFootnote && activateFootnote(view, pos)) {
    event.preventDefault()
    return true
  }
  if (!onLink || !openIntent) return false

  const href = linkAt(view.state, pos)?.href ?? onLink.getAttribute("href")
  if (!href) return false

  event.preventDefault()
  if (href.startsWith("#")) {
    const heading = headingPositionForAnchor(view.state, href)
    if (heading !== null) view.dispatch({ selection: { anchor: heading }, scrollIntoView: true })
    return true
  }
  const classified = classifyLink(href)
  if (classified.kind === "external") {
    view.state.facet(externalHrefHandler)[0]?.(classified.href)
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

function createStatusReporter(options: CreateEditorOptions) {
  let previous: EditorStatus | null = null
  return (view: EditorView) => {
    if (!options.onStatusChange) return
    const next = editorStatus(view)
    if (previous && sameEditorStatus(previous, next)) return
    previous = next
    options.onStatusChange(next)
  }
}

const spellcheckCompartment = new Compartment()

function spellcheckAttr(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" })
}

export function setEditorSpellcheck(view: EditorView, on: boolean): void {
  view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckAttr(on)) })
}

function createEditorState(
  options: CreateEditorOptions,
  reportStatus: (view: EditorView) => void,
): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      EditorView.lineWrapping,
      spellcheckCompartment.of(spellcheckAttr(options.spellcheck === true)),
      options.tabSize ? EditorState.tabSize.of(options.tabSize) : [],
      options.readOnly ? EditorState.readOnly.of(true) : [],
      history(),
      tightSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      editorExtensions({
        resolveImageSrc: makeImageResolver(options.getDocPath),
        imageBrokenLabel: (src: string) => t("image.broken", { src }),
        defaultLivePreview: options.defaultLivePreview,
      }),
      options.onOpenMarkdownHref ? markdownHrefHandler.of(options.onOpenMarkdownHref) : [],
      options.onOpenExternalHref ? externalHrefHandler.of(options.onOpenExternalHref) : [],
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
        reportStatus(update.view)
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "15px" },
        ".cm-scroller": { overflow: "auto", lineHeight: "1.7" },
        ".cm-content": {
          padding: "16px 24px max(16px, 50vh)",
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
  const reportStatus = createStatusReporter(options)
  const view = new EditorView({
    state: createEditorState(options, reportStatus),
    parent,
  })
  reportStatus(view)
  return view
}

/** The status snapshot type lives in `editorStatus.ts` with its equality; re-exported
 * here because the editor is where hosts pick it up (`CreateEditorOptions.onStatusChange`). */
export type { EditorStatus }

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
  const reportStatus = createStatusReporter(options)
  view.setState(createEditorState(options, reportStatus))
  reportStatus(view)
}
