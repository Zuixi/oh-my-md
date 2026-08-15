import { markdownLanguageSupport } from "./parse/markdown"
import { emojiCompletion } from "./parse/emojiComplete"
import { livePreviewCompartment, livePreviewExt, isLivePreview, toggleKeymap } from "./modes/livePreview"
import { imageResolver } from "./decorations/widgets/image"
import { orderedNormalizationState } from "./lists/ordered"
import { markdownKeymap } from "./format/commands"

export { collectOutline, type OutlineItem } from "./outline"
export { exportHtml } from "./export/html"
export { headingPositionForAnchor, headingSlug, linkAt, linkHref, type LinkTarget } from "./links"
export { applyToggle, isLivePreview } from "./modes/livePreview"
export { markdownKeymap } from "./format/commands"
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

export interface EngineOptions {
  // 宿主把 markdown 里的图片 src 解析成可加载的 URL（desktop: 相对路径 → convertFileSrc）
  resolveImageSrc?: (src: string) => string
}

export function editorExtensions(options: EngineOptions = {}) {
  return [
    markdownLanguageSupport(),
    emojiCompletion,
    markdownKeymap,
    // Outside the compartment: a pending normalization must outlive Source/Live toggles.
    orderedNormalizationState,
    livePreviewCompartment.of(livePreviewExt()),
    isLivePreview,
    toggleKeymap,
    imageResolver.of(options.resolveImageSrc ?? ((s: string) => s)),
  ]
}
