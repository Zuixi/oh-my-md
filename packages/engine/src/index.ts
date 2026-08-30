import { markdownLanguageSupport } from "./parse/markdown"
import { emojiCompletion } from "./parse/emojiComplete"
import { livePreviewCompartment, livePreviewExt, isLivePreview, toggleKeymap } from "./modes/livePreview"
import { defaultBroken, imageBrokenLabel, imageResolver } from "./decorations/widgets/image"
import { renderBudgetFlush } from "./decorations/renderBudget"
import { orderedNormalizationState } from "./lists/ordered"
import { markdownKeymap } from "./format/commands"
import { listKeymap } from "./format/lists"
import { fenceKeymap } from "./format/fences"
import { htmlPaste } from "./paste/htmlPaste"

// Spec 05：>30k 行提示大文档；>50k 行进入安全模式（desktop 镜像于 constants.ts，
// crossLayerConstants.test.ts 漂移守护）。归 engine 所有：装饰/渲染档位由语义方定义。
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000

export { collectOutline, type OutlineItem } from "./outline"
export { exportHtml, exportRichHtml, type ExportRichHtmlOptions } from "./export/html"
export { EXPORT_BODY_CSS } from "./export/styles"
export { defaultBroken, imageBrokenLabel, imageResolver } from "./decorations/widgets/image"
export {
  classifyLink,
  headingPositionForAnchor,
  headingSlug,
  linkAt,
  linkHref,
  type LinkTarget,
  type ResolvedLink,
} from "./links"
export {
  footnoteAt,
  footnoteDefinitionPosition,
  footnoteReferencePosition,
  type FootnoteTarget,
} from "./footnotesNav"
export { applyToggle, isLivePreview, setLivePreview } from "./modes/livePreview"
export { toggleKeyBindings, toggleShortcutBindings, toggleShortcutLabels } from "./modes/livePreview"
export { markdownKeyBindings, markdownKeymap, markdownShortcutBindings, markdownShortcutLabels } from "./format/commands"
export { continueList, indentList, listKeymap, outdentList } from "./format/lists"
export { continueFence, continueFenceSpec, fenceKeymap } from "./format/fences"
export { documentStats, type DocumentStats } from "./stats"
export { buildTextFromChunks, createTextAssembler, type ChunkedTextAssembler } from "./docText"
export {
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleUnorderedList,
} from "./format/commands"
export {
  acceptOrderedListNormalization,
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
  type NormalizationId,
  type OrderedListNormalizationAcceptResult,
  type OrderedListNormalizationNotice,
  type OrderedListNormalizationRejectResult,
} from "./lists/ordered"
export {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
} from "./tables/edit"
export {
  convertHtmlToMarkdown,
  htmlPaste,
  htmlPasteToMarkdown,
} from "./paste/htmlPaste"
export {
  blockRenderBudget,
  renderBudgetFlush,
  SAFE_MODE_RENDER_BUDGET_LINES,
  setBlockRenderBudget,
  withinRenderBudget,
} from "./decorations/renderBudget"
export {
  LIVE_PRUNE_MARGIN_CHARS,
  LIVE_WINDOW_CHARS,
  safeModeRenderingEnabled,
  setSafeModeRendering,
} from "./safeModeRendering"

export interface EngineOptions {
  // 宿主把 markdown 里的图片 src 解析成可加载的 URL（desktop: 相对路径 → convertFileSrc）
  resolveImageSrc?: (src: string) => string
  imageBrokenLabel?: (src: string) => string
  /** When false, construct the editor already in Source (no live decorations). */
  defaultLivePreview?: boolean
}

export function editorExtensions(options: EngineOptions = {}) {
  const live = options.defaultLivePreview !== false
  return [
    markdownLanguageSupport(),
    emojiCompletion,
    listKeymap,
    fenceKeymap,
    htmlPaste(),
    renderBudgetFlush(),
    markdownKeymap,
    // Outside the compartment: a pending normalization must outlive Source/Live toggles.
    orderedNormalizationState,
    livePreviewCompartment.of(live ? livePreviewExt() : []),
    // Replace the default field so create() starts false; keep the same
    // exported `isLivePreview` field for readers (setLivePreview / editorStatus).
    isLivePreview.init(() => live),
    toggleKeymap,
    imageResolver.of(options.resolveImageSrc ?? ((s: string) => s)),
    imageBrokenLabel.of(options.imageBrokenLabel ?? defaultBroken),
  ]
}
