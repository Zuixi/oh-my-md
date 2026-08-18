#!/usr/bin/env node
// 发布前人工性能烟测（Spec 05 §4/§7）：
//   1) 生成 10k/50k 行确定性样本到 /tmp/omd-perf-smoke/
//   2) 提示人工打开样本并操作（打开-可输入、滚动、多标签）
//   3) 循环采样 oh-my-md 进程 RSS，写 perf-smoke-result.json
// 用法：node scripts/perf-smoke.mjs（Ctrl-C 结束采样并落盘）
import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// SYNC: packages/engine/bench/generate.ts —— 本函数是 engine 基准生成器的内联复刻
// （脚本是独立 ESM，不依赖 workspace TS 源码路径；仓库 tsconfig 无 allowJs，无法
// 反向 import）。修改任一侧的块逻辑时，grep "SYNC:" 同步两处，否则烟测样本与基准
// 负载漂移，历史对比失真。
function makeBenchmarkDoc(lines) {
  const blocks = []
  let produced = 0
  for (let i = 0; produced < lines; i++) {
    const kind = i % 10
    let block
    if (kind === 0) block = `# 标题 ${i}\n\n中文段落 ${i}，包含 **加粗**、[链接](https://example.com/${i}) 与普通文本。`
    else if (kind === 3) block = `| h${i} | v${i} |\n|---|---|\n| 行${i} | 中文单元格 |\n| 行${i + 1} | another cell |`
    else if (kind === 6) block = "```ts\nconst value" + i + " = " + i + ";\nfunction fn" + i + "() { return value" + i + " * 2; }\n```"
    else if (kind === 8) block = "$$\nE_{" + i + "} = mc^2 + " + i + "\n$$"
    else block = `段落 ${i}：中文正文与 English mixed content，用于逐键输入负载。`
    blocks.push(block)
    produced += block.split("\n").length + 1
  }
  return blocks.join("\n\n")
}

const outDir = join(tmpdir(), "omd-perf-smoke")
mkdirSync(outDir, { recursive: true })
for (const n of [10000, 50000]) {
  writeFileSync(join(outDir, `sample-${n}.md`), makeBenchmarkDoc(n))
  console.log(`wrote ${join(outDir, `sample-${n}.md`)}`)
}

console.log("\n人工步骤：")
console.log("  1. 启动应用（pnpm dev 或打包产物）")
console.log("  2. 打开 sample-10000.md，连续输入 10s 记录可感延迟")
console.log("  3. 打开 sample-50000.md（应触发安全模式），滚动 + IME 输入")
console.log("  4. 开满 10 个标签各载入 sample-10000.md，观察前台输入")
console.log("采样进行中（每 2s 记录 RSS），Ctrl-C 结束并写结果。\n")

const samples = []
const timer = setInterval(() => {
  try {
    const out = execSync(
      "ps axo rss,comm | grep -i 'oh-my-md' | grep -v grep | awk '{s+=$1} END {print s+0}'",
      { encoding: "utf8" },
    ).trim()
    const kb = Number(out)
    if (kb > 0) {
      samples.push({ t: Date.now(), rssKb: kb })
      process.stdout.write(`\rrss: ${(kb / 1024).toFixed(1)} MiB (n=${samples.length})`)
    }
  } catch { /* 进程未启动 */ }
}, 2000)

process.on("SIGINT", () => {
  clearInterval(timer)
  const result = {
    date: new Date().toISOString(),
    samples,
    peakRssKb: samples.reduce((max, s) => Math.max(max, s.rssKb), 0),
  }
  const resultPath = join(outDir, "perf-smoke-result.json")
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log(`\nwrote ${resultPath} (peak RSS ${(result.peakRssKb / 1024).toFixed(1)} MiB)`)
  process.exit(0)
})
