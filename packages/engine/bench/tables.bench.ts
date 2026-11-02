import { bench, describe } from "vitest"
import {
  budgetLine, ESTIMATE_GAIN_FLOOR, fullyParsedLiveState, measureDecoRebuildMs,
  measureTableDrawsMs, measureTyping, tableEstimateGain, TABLE_DRAW_BUDGET_MS,
  TYPING_P95_BUDGET_MS,
} from "./measure"
import { makeTableHeavyDoc } from "./generate"

// 表格滚动性能基准（advisory）：根因是(a)整表同步渲染成本（滚入视口即付，
// 滚出销毁后再滚入重付）与(b)块 widget 高度估算缺省按一行行高 → 视口像素→
// 字符换算过绘 + 实测修正回环。本文件度量两端的可量化代理：
//   - estimate gain：estimatedHeight 相对一行行高基线的倍数（修复 b 的回归守护）；
//   - table draw p95：一张表滚入视口的引擎侧脚本成本（修复 a 的基线，供
//     后续表格渲染缓存/分段渲染方案对比）。
// 数值在 CI/本机间抖动大（见 known-gotchas「Benchmark jitter is real」），
// 只做同机前后对比，预算超限告警不阻断。

// 40 张 20 行 × 8 列表 + 间隔文本 ≈ 数百 KB「大量表格」文档形态。
const DOC_TABLES = makeTableHeavyDoc(40, 20, 8)
// 大表口径：100 行 × 6 列。
const DOC_BIG_TABLES = makeTableHeavyDoc(6, 100, 6)

describe("table scroll benchmarks (advisory)", () => {
  bench("height estimate gain 40x(20r x 8c)", () => {
    const r = tableEstimateGain(DOC_TABLES)
    const verdict = r.gain >= ESTIMATE_GAIN_FLOOR ? "OK" : `UNDER FLOOR (< ${ESTIMATE_GAIN_FLOOR}x)`
    console.info(
      `table estimate gain: ${r.gain.toFixed(1)}x — estimated ${Math.round(r.estimatedPx)}px vs line-only ${Math.round(r.baselinePx)}px over ${r.blockCount} blocks — ${verdict}`,
    )
  })

  bench("table viewport entry 20r x 8c (draw p95)", async () => {
    const r = await measureTableDrawsMs(DOC_TABLES, { tables: 10 })
    console.info(budgetLine("table draw p95 20r x 8c", r.p95Ms, TABLE_DRAW_BUDGET_MS))
  })

  bench("table viewport entry 100r x 6c (draw p95)", async () => {
    const r = await measureTableDrawsMs(DOC_BIG_TABLES, { tables: 6 })
    console.info(budgetLine("table draw p95 100r x 6c", r.p95Ms, TABLE_DRAW_BUDGET_MS))
  })

  bench("deco rebuild table-heavy 40x(20r x 8c)", () => {
    const state = fullyParsedLiveState(DOC_TABLES)
    console.info(`deco rebuild 40 tables: ${measureDecoRebuildMs(state).toFixed(2)}ms`)
  })
})

// 表格内打字基准（advisory）：源码模式下光标进表格后，「在单元格里打字」不再是
// 输入框内零事务的本地编辑，而是每键一次真实文档事务（增量重解析 + 表格
// widget/装饰更新）。此为热路径变更，用基准锁住 —— 表格内 p95 应与整篇同量级，
// 预算沿用逐键 16ms（超限告警不阻断，见 known-gotchas「Benchmark jitter is real」）。
const TABLE_TYPE_DOC = [
  "# 表格输入基准",
  "",
  "| A | B | C | D | E | F | G | H |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: 60 }, (_, r) =>
    `| a${r} | b${r} | c${r} | d${r} | e${r} | f${r} | g${r} | h${r} |`),
  "",
].join("\n")
const TABLE_TYPE_CARET = TABLE_TYPE_DOC.indexOf("| a30 |")

describe("table typing benchmark (advisory)", () => {
  bench("typing inside a 60r x 8c table (live, steady)", () => {
    const r = measureTyping(TABLE_TYPE_DOC, {
      mode: "live", tree: "steady", keystrokes: 60, caret: TABLE_TYPE_CARET,
    })
    console.info(budgetLine("typing p95 in-table 60r x 8c live", r.p95Ms, TYPING_P95_BUDGET_MS))
  })
})
