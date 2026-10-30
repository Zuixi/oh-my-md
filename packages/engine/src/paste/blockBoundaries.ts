import type { Text } from "@codemirror/state"
import type { PasteBoundary } from "./model"

/**
 * 粘贴块级内容的边界规整（Typora 语义）：块级 Markdown 落在自己的块边界里，
 * 光标停在块后的空行上 —— 粘贴即渲染，无需按 Enter。
 *
 * 为什么做在粘贴层而不是装饰层：blockSelected（decorations/blockWidget.ts）把
 * [from, to] 边界算块内是 load-bearing 的 —— 手敲表格行/围栏收尾时光标恰停在
 * node.to，半开判定会让 widget 在打字中途吞掉正在编辑的行、卡死光标（M2
 * root cause C）。粘贴与打字在 state.selection 上不可区分，装饰层没有安全判据；
 * 让粘贴根本不把光标留在块边界上，两条规则互不冲突。守护测试：
 * test/tables.test.ts「keeps a caret resting exactly on the end boundary」。
 */

export interface NormalizedPaste {
  /** 规整后的插入文本（可能获得分隔换行）。 */
  text: string
  /** 相对插入点的光标偏移（恒为 text.length：光标停在插入内容末尾）。 */
  caret: number
}

// 逐行块级探测（保守：只认行首标记；语义 serializer 的块输出均为行首标记）。
const RE_FENCE = /^ {0,3}(?:```|~~~)/
const RE_FENCE_CLOSE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/
const RE_TABLE_ROW = /^ {0,3}\|/
const RE_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const RE_QUOTE = /^ {0,3}>/
const RE_MATH = /^ {0,3}\$\$/
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2}$/
const RE_LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/

function isBlockLine(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_QUOTE.test(line)
    || RE_MATH.test(line) || RE_HR.test(line) || RE_TABLE_ROW.test(line)
    || RE_LIST.test(line)
}

// 不透明块（表格/围栏/数学/hr）结尾：其后必须有空行，光标才不压在块 widget
// 的 replace 末边界上。按插入文本的末行判定。
function endsWithOpaqueBlock(insert: string): boolean {
  const last = insert.slice(insert.lastIndexOf("\n") + 1)
  return RE_FENCE_CLOSE.test(last) || RE_TABLE_ROW.test(last)
    || RE_MATH.test(last) || RE_HR.test(last)
}

/**
 * 规整富文本粘贴产出的块级 Markdown：
 * - 前缘：行中插入拆断宿主行（`\n\n`）；行首且上一行非空补一个换行（表格/
 *   围栏不能打断段落）；BOF 或上一行已空则不动。
 * - 后缘：同行后方还有文字补 `\n\n`（否则被吸收进块，复现过的表格吞字）；
 *   否则以不透明块结尾时补一个 `\n`（光标移出 replace 边界，粘贴即渲染）。
 * 纯段落文本逐字节不变。
 *
 * 省略 `boundary` 的调用方保留默认逐行块级探测。
 *
 * 传入 serializer 给出的 `PasteBoundary` 时进入边界感知模式：块/不透明片段
 * 无论文本内容是否「看起来像块」都独占块位（strict 回退的转义字面文本靠
 * 这条隔离，否则它会贴在邻座的落单反斜杠/强调定界符上被改写），并且行首
 * 前一行非空时用空行而非单换行分隔（表格/围栏无法打断段落）。
 *
 * ponytail: 只保证「不会吞掉 stable prefix/suffix + 可见文本不受邻座影响」；
 * 宿主自身是未闭合围栏/HTML 块这类跨行容器时，纯文本无法自保 —— 那是
 * 验证器 crossingNode/boundary 拒绝的领域，本函数不重写宿主源码。
 */
export function normalizeBlockPaste(
  doc: Text,
  from: number,
  to: number,
  insert: string,
  boundary?: PasteBoundary,
): NormalizedPaste {
  if (boundary === undefined) return normalizeLegacy(doc, from, to, insert)
  const isolated = boundary.start !== "inline" || boundary.end !== "inline"
  if (!isolated && !insert.split("\n").some(isBlockLine)) return { text: insert, caret: insert.length }

  let text = insert
  const line = doc.lineAt(from)
  if (from > line.from || (from > 0 && doc.lineAt(line.from - 1).text.trim().length > 0)) {
    text = "\n\n" + text
  }
  if (boundary.end === "htmlBlock" || to < doc.lineAt(to).to) {
    text += "\n\n"
  } else if (boundary.end === "opaque" || endsWithOpaqueBlock(text)) {
    text += "\n"
  }
  return { text, caret: text.length }
}

/** 遗留路径（无 boundary）：字节兼容既有调用方与测试。 */
function normalizeLegacy(doc: Text, from: number, to: number, insert: string): NormalizedPaste {
  if (!insert.split("\n").some(isBlockLine)) return { text: insert, caret: insert.length }

  let text = insert
  const line = doc.lineAt(from)
  if (from > line.from) {
    text = "\n\n" + text
  } else if (from > 0 && doc.lineAt(line.from - 1).text.trim().length > 0) {
    text = "\n" + text
  }

  if (to < doc.lineAt(to).to) {
    text += "\n\n"
  } else if (endsWithOpaqueBlock(text)) {
    text += "\n"
  }
  return { text, caret: text.length }
}
