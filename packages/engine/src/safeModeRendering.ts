// 安全模式（over-scale）窗口化装饰（Task 3）：50MB 级文档若把 LiveDeco.pending
// 排空到全量，specs 数组 + RangeSets 会持有整篇装饰，且每笔编辑都要映射百万级
// 区间。开启后 live 装饰改为「视口窗口」语义：只构建/保留视口附近的装饰，窗口
// 外的退回 pending（滚动进入时重建）—— 装饰内存与映射成本都以窗口为界。
// 模块级全局（仿 renderBudget.ts 的 budgetLines）：单窗口应用的档位策略，
// desktop 在安全模式 tab 激活/切换时设置（applyRenderBudgetFor 与
// setBlockRenderBudget 同参联动）。默认 false：普通文档保持「排空到全量」语义。

// 构建窗口半径：各可见段两侧各扩 262_144（2^18）字符。与 LIVE_BUILD_CHUNK_CHARS
// 同量级 —— 滚动进入窗口的新区域约对应一个分片的构建工作量。
export const LIVE_WINDOW_CHARS = 262_144

// 裁剪迟滞裕量：装饰被裁回 pending 的窗口比构建窗口再多 32_768（2^15）字符。
// 构建与裁剪若共用同一边界，恰好建在窗口边缘的装饰会随视口小幅往返在
// 「构建 ↔ 裁剪」间抖动；裕量保证装饰被裁前至少要再远离构建窗口边缘 32k 字符。
export const LIVE_PRUNE_MARGIN_CHARS = 32_768

let safeMode = false

export function setSafeModeRendering(on: boolean): void {
  safeMode = on
}

export function safeModeRenderingEnabled(): boolean {
  return safeMode
}
