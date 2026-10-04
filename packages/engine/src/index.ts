import { markdownLanguageSupport } from "./parse/markdown"
import { emojiCompletion } from "./parse/emojiComplete"
import { livePreviewCompartment, livePreviewExt, isLivePreview, toggleKeymap } from "./modes/livePreview"
import { codeSyntaxHighlighting } from "./highlight/codeHighlight"
import { defaultBroken, imageBrokenLabel, imageResolver } from "./decorations/widgets/image"
import { renderBudgetFlush } from "./decorations/renderBudget"
import { orderedNormalizationState } from "./lists/ordered"
import { markdownKeymap } from "./format/commands"
import { quoteKeymap } from "./format/quotes"
import { listKeymap } from "./format/lists"
import { fenceKeymap } from "./format/fences"
import { codeIndentKeymap, codeLineKeymap } from "./format/codeLines"
import { caretClampHandlers, caretClampKeymap } from "./navigation/caretClamp"
import { htmlPaste } from "./paste/htmlPaste"
import {
  autoPairCompartment,
  autoPairExtension,
  DEFAULT_AUTO_PAIR,
  type AutoPairOptions,
} from "./format/autoPair"

// Spec 05：>30k 行提示大文档；>50k 行进入安全模式（desktop 镜像于 constants.ts，
// crossLayerConstants.test.ts 漂移守护）。归 engine 所有：装饰/渲染档位由语义方定义。
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000

export { collectOutline, type OutlineItem } from "./outline"
export { codeHighlightStyle } from "./highlight/codeHighlight"
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
export { blockPrefixOf, continuePrefixText, markRemovalRange } from "./format/blockPrefix"
export { continueQuote, continueQuoteSpec, quoteKeymap } from "./format/quotes"
export { caretClampHandlers, caretClampKeymap } from "./navigation/caretClamp"
export {
  codeContentLine,
  continueCodeLine,
  continueCodeLineSpec,
  indentCodeLine,
  indentCodeLineSpec,
  outdentCodeLine,
  outdentCodeLineSpec,
  codeIndentKeymap,
  codeLineKeymap,
} from "./format/codeLines"
export { continueFence, continueFenceSpec, fenceKeymap, isUnclosedFenceLine } from "./format/fences"
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
  escapeTableCellValue,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
  setTableColumnAlignment,
  type TableSourceChange,
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
// 自动配对对 desktop 只暴露这两个（Task 2 从此处导入）；Compartment 与 extension
// 留在 format/autoPair.ts，不经 barrel 导出。
export { setAutoPair, type AutoPairOptions } from "./format/autoPair"

export interface EngineOptions {
  // 宿主把 markdown 里的图片 src 解析成可加载的 URL（desktop: 相对路径 → convertFileSrc）
  resolveImageSrc?: (src: string) => string
  imageBrokenLabel?: (src: string) => string
  /** When false, construct the editor already in Source (no live decorations). */
  defaultLivePreview?: boolean
  /** Markdown-aware auto pairing toggles (three independent switches per §4.1). */
  autoPair?: AutoPairOptions
}

export function editorExtensions(options: EngineOptions = {}) {
  const live = options.defaultLivePreview !== false
  return [
    markdownLanguageSupport(),
    emojiCompletion,
    // Enter 归属（顺序 + Prec 双重确定）：围栏代码**内容行** → continueCodeLine
    // （复制行块前缀与代码缩进并把光标显式放到新行内容起点）→ 未闭合围栏行 →
    // continueFence（含引用内的围栏，按前缀补全闭合行）→ 带 QuoteMark 的行 →
    // continueQuote → 纯列表行 → continueList / 宿主上游命令。四者条件互斥，各自
    // 对不属于自己的行返回 false。
    //
    // 必须 Prec.highest：@codemirror/lang-markdown 的 markdown() 内部会
    // `support.push(Prec.high(keymap.of(markdownKeymap)))`（Enter →
    // insertNewlineContinueMarkup），而 markdownLanguageSupport() 是本数组第一项 ——
    // 同优先级下先注册者胜，停在 Prec.high 会让上游抢走 Enter，引擎语义（空前缀行
    // 退层、`>x` 风格保真、围栏补全、代码行缩进）在真实编辑器里全部失效。
    codeLineKeymap,
    codeIndentKeymap,
    fenceKeymap,
    quoteKeymap,
    listKeymap,
    // 点击/Home/↑↓ 的光标钳制：前缀是块结构，误入会让标记展开、字插到 `>` 左边。
    // 排在 livePreviewCompartment 之前，让块间 ↑/↓ 进入（blockEntry）优先命中。
    caretClampKeymap,
    caretClampHandlers,
    htmlPaste(),
    // 引擎自研的 Markdown 感知配对（禁止 stock closeBrackets）：inputHandler 覆盖全部
    // 选区（D10），Backspace 用 Prec.high 抢在 defaultKeymap 的 deleteCharBackward 之前。
    // 三个开关经 compartment 热切换（desktop: setAutoPair）。
    autoPairCompartment.of(autoPairExtension(options.autoPair ?? DEFAULT_AUTO_PAIR)),
    renderBudgetFlush(),
    markdownKeymap,
    // Outside the compartment: a pending normalization must outlive Source/Live toggles.
    orderedNormalizationState,
    livePreviewCompartment.of(live ? livePreviewExt() : []),
    codeSyntaxHighlighting(),
    // Replace the default field so create() starts false; keep the same
    // exported `isLivePreview` field for readers (setLivePreview / editorStatus).
    isLivePreview.init(() => live),
    toggleKeymap,
    imageResolver.of(options.resolveImageSrc ?? ((s: string) => s)),
    imageBrokenLabel.of(options.imageBrokenLabel ?? defaultBroken),
  ]
}
