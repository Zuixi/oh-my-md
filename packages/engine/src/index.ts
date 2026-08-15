import { markdownLanguageSupport } from "./parse/markdown"
import { emojiCompletion } from "./parse/emojiComplete"
import { livePreviewCompartment, livePreviewExt, isLivePreview, toggleKeymap } from "./modes/livePreview"
import { imageResolver } from "./decorations/widgets/image"
import { orderedNormalizationState } from "./lists/ordered"
import { markdownKeymap } from "./format/commands"
import { listKeymap } from "./format/lists"

export { collectOutline, type OutlineItem } from "./outline"
export { exportHtml, exportRichHtml, type ExportRichHtmlOptions } from "./export/html"
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
export { applyToggle, isLivePreview } from "./modes/livePreview"
export { markdownKeymap } from "./format/commands"
export { continueList, indentList, listKeymap, outdentList } from "./format/lists"
export { documentStats, type DocumentStats } from "./stats"
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

export interface EngineOptions {
  // 宿主把 markdown 里的图片 src 解析成可加载的 URL（desktop: 相对路径 → convertFileSrc）
  resolveImageSrc?: (src: string) => string
}

export function editorExtensions(options: EngineOptions = {}) {
  return [
    markdownLanguageSupport(),
    emojiCompletion,
    markdownKeymap,
    listKeymap,
    // Outside the compartment: a pending normalization must outlive Source/Live toggles.
    orderedNormalizationState,
    livePreviewCompartment.of(livePreviewExt()),
    isLivePreview,
    toggleKeymap,
    imageResolver.of(options.resolveImageSrc ?? ((s: string) => s)),
  ]
}
