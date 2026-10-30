/**
 * Smart Paste normalizer 的输入护栏（plan 02 Task 2）。
 *
 * 剪贴板 HTML 是不可信输入：`DOMParser` 已经为整棵文档分配了内存，我们能
 * 约束的是遍历本身。深度与节点数超限时 normalizer 直接退回
 * `preparePlainTextFallback`，绝不返回一棵被静默截断的部分 AST。
 *
 * 这两个值在 Task 6 由 importer benchmark 的实测结果收紧；它们只在 engine
 * 里定义一次，desktop 不得复述。
 */

/** 从 `<body>` 直接子元素算起（深度 1）的最大元素嵌套深度。 */
export const MAX_PASTE_DOM_DEPTH = 256

/** 计入预算的 DOM 节点数（元素 + 文本节点），跳过的子树照样计数。 */
export const MAX_PASTE_DOM_NODES = 200_000

/** DOMParser 前的同步分配熔断；超限直接使用 text/plain 严格回退。 */
export const MAX_PASTE_HTML_CHARS = 262_144

/**
 * 一次校验（plan 02 Task 4）允许从当前语法树读入的上下文窗口，前后各一段。
 * 超过它就不做「prefix + 候选 + suffix」的合成解析：没有可用的已覆盖上下文
 * 时宁可保守退回 strict literal，也不为验证去补全整棵树。
 */
export const MAX_PASTE_VALIDATION_CONTEXT_CHARS = 16_384

/**
 * 允许送去合成解析的候选插入长度。超过就按保守路径处理（零解析）。
 * 这个上限同时是「验证永远不解析整篇大文档」的成本闸门。
 */
export const MAX_PASTE_VALIDATED_INSERT_CHARS = 262_144
