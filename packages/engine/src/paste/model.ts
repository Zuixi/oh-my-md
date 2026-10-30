/**
 * Smart Paste AST 契约（plan 02 Task 1）。
 *
 * 临时、不可变、无 DOM：没有节点 ID、DOM 路径、source map 或 Lezer 节点。
 * 这里只有类型，没有任何构造/加工函数——normalizer、serializer、validator
 * 各自产出这些形状，但都不允许原地修改已有 payload。
 */

export type PasteInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong" | "emphasis" | "strike" | "highlight" | "underline" | "kbd" | "subscript" | "superscript"; readonly children: readonly PasteInline[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly title: string | null; readonly children: readonly PasteInline[] }
  | { readonly type: "image"; readonly alt: string; readonly title: string | null; readonly source: PasteImageSource }
  | { readonly type: "hardBreak" }

export type PasteImageSource =
  | { readonly kind: "url"; readonly value: string }
  | { readonly kind: "embedded"; readonly key: string; readonly mime: string; readonly base64: string }
  | { readonly kind: "unavailable"; readonly key: string }

export type PasteBlock =
  | { readonly type: "paragraph"; readonly children: readonly PasteInline[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly PasteInline[] }
  | { readonly type: "blockquote"; readonly children: readonly PasteBlock[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly start: number | null; readonly items: readonly PasteListItem[] }
  | { readonly type: "codeBlock"; readonly language: string; readonly value: string }
  | { readonly type: "table"; readonly table: PasteTable }
  | { readonly type: "horizontalRule" }

export interface PasteListItem {
  readonly checked: boolean | null
  readonly children: readonly PasteBlock[]
}

export interface PasteTableCell {
  readonly header: boolean
  readonly scope: "row" | "col" | null
  readonly rowSpan: number
  readonly colSpan: number
  readonly align: "left" | "center" | "right" | null
  readonly blocks: readonly PasteBlock[]
}
export interface PasteTableRow { readonly cells: readonly PasteTableCell[] }
export interface PasteTable { readonly rows: readonly PasteTableRow[]; readonly requiresComplexHtml: boolean }
export interface PasteDocument { readonly blocks: readonly PasteBlock[] }
export interface PasteAsset { readonly key: string; readonly mime: string; readonly base64: string; readonly alt: string }
export interface PasteDiagnostic { readonly kind: "strictFallback" | "unsupportedTable" | "droppedStyle" | "rejectedUrl" | "unresolvedAsset"; readonly count: number }
export interface SmartPasteInput { readonly html: string; readonly plainText: string }
export interface PreparedSmartPaste {
  readonly policy: "semantic" | "literalFallback"
  readonly document: PasteDocument
  readonly plainText: string
  readonly assets: readonly PasteAsset[]
  readonly unavailableImageKeys: readonly string[]
  readonly isSingleImageOnly: boolean
  readonly diagnostics: readonly PasteDiagnostic[]
}
export interface PasteBoundary {
  readonly start: "inline" | "block"
  readonly end: "inline" | "block" | "opaque" | "htmlBlock"
}
export interface SerializedPaste {
  readonly text: string
  readonly boundary: PasteBoundary
  readonly diagnostics: readonly PasteDiagnostic[]
}
export interface SmartPastePlan { readonly kind: "plain" | "markdown"; readonly text: string; readonly diagnostics: readonly PasteDiagnostic[] }
