import { Text } from "@codemirror/state"
import { CHAR_CARRIAGE_RETURN, CHAR_NEWLINE } from "./parse/chars"

/**
 * 与 @codemirror/state 内部 DefaultSplit（EditorState.create 收到字符串 doc 时的
 * 切行正则）同构：\r\n 优先，其次 \r 与 \n。分块切行必须与之逐字符等价，否则流式
 * 组装出的 Text 与整串路径不同构（test/docText.test.ts 以全边界扫描守护 parity）。
 * 仓库未配置 EditorState.lineSeparator facet，自定义分隔符不在等价范围内。
 */
const LINE_SPLIT = /\r\n?|\n/
const CR_STR = String.fromCharCode(CHAR_CARRIAGE_RETURN)

/**
 * 行数攒够即 fold 进累积 rope 的批阈值。TextLeaf 单叶上限 32 行、append 只在
 * 右 spine 上重平衡，512 行一批让 512KiB chunk（数千行）摊成少量 append，
 * 同时避免把全部行留在一个待切数组里（峰值内存与整串切行同型）。
 */
const FLUSH_LINES = 512

export interface ChunkedTextAssembler {
  /** 按到达顺序喂入一个 chunk；跨 chunk 边界的 \r\n 由内部携带状态处理。 */
  push(chunk: string): void
  /** 流结束后调用一次：收尾最后的未完行并返回完整 Text。 */
  finish(): Text
}

/**
 * Task 10（2026-08-20 大文件计划）：LARGE 档流式打开的摄入路径优化。
 * EditorState.create({doc: string}) 内部对整串跑一次 regex 行切分（50MB 数秒
 * 主线程）；IPC chunk 到达时即做 chunk 局部切行、Text.of 后 append 累积成
 * rope，EditorState.create({doc: Text}) 则完全跳过整串切分。产出的 Text 必须
 * 与 Text.of(joined.split(DefaultSplit)) eq —— 切行语义见 LINE_SPLIT。
 *
 * 跨 chunk 危险点只有一种：chunk 末尾的 \r 可能是 \r\n 的前半。Rust 侧 chunk
 * 边界只对齐 UTF-8 字符边界、不对齐换行，故此处携带 pendingCr —— 下一 chunk
 * 首字符是 \n 时把该 \n 归入分隔符（跳过），否则 \r 已按单字符行结束处理。
 */
export function createTextAssembler(): ChunkedTextAssembler {
  let acc: Text | null = null
  let openLine = ""
  let pendingCr = false
  let batch: string[] = []

  const flush = () => {
    if (batch.length === 0) return
    // append 是 replace(length, length, …) 语义：被追加文本的首行会并进 acc 的
    // 末行（不产生换行）。批次前垫一个空「接合行」——acc 末行 + "" 不变，其后
    // 才是新行断 —— 才能与整串切行同构（首批无需垫：文本从首批首行开始）。
    const next = Text.of(acc === null ? batch : ["", ...batch])
    batch = []
    acc = acc === null ? next : acc.append(next)
  }

  return {
    push(chunk) {
      let s = chunk
      // 空 chunk 不推进任何状态：pendingCr 的裁决必须留给下一个非空 chunk，
      // 否则 "\r" + "" + "\n" 会把一个 \r\n 拆成两个独立分隔符（多出一空行）。
      if (s.length === 0) return
      if (pendingCr) {
        pendingCr = false
        if (s.charCodeAt(0) === CHAR_NEWLINE) s = s.slice(1)
        if (s.length === 0) return
      }
      // 无 \r 的 chunk 走 "\n" 字面量切分（V8 split 的字符串快路径，显著快于
      // 正则交替）；含 \r 才用与 DefaultSplit 同构的正则。无 \r 时两者产出恒等。
      const parts = s.indexOf(CR_STR) < 0 ? s.split("\n") : s.split(LINE_SPLIT)
      if (parts.length === 1) {
        // chunk 内无分隔符：整段接在未完行尾部（V8 cons string，O(1) 追加）。
        openLine += s
        return
      }
      // parts[0] 补完上一未完行；中间元素均已以分隔符收尾；末元素是新未完行。
      batch.push(openLine + parts[0])
      for (let i = 1; i < parts.length - 1; i++) batch.push(parts[i])
      openLine = parts[parts.length - 1]
      pendingCr = s.charCodeAt(s.length - 1) === CHAR_CARRIAGE_RETURN
      if (batch.length >= FLUSH_LINES) flush()
    },
    finish() {
      batch.push(openLine)
      flush()
      return acc ?? Text.empty
    },
  }
}

/** 便捷形态：从既有 chunk 序列一次性组装 Text（等价 createTextAssembler 逐个 push）。 */
export function buildTextFromChunks(chunks: readonly string[]): Text {
  const assembler = createTextAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.finish()
}
