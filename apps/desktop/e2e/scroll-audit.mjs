// 量化「估算总高 vs 实测总高」偏差（thumb 对齐问题的直接来源）。
// 文档经 dispatch 注入（220KB 走 URL 会被 dev server 拒绝）。
import { chromium } from "@playwright/test"
import { readFileSync } from "node:fs"

const file = process.argv[2] ?? "E:/journal/demo-docs/01-认知与学习.md"
const doc = readFileSync(file, "utf8")

const browser = await chromium.launch({ channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
await page.goto("http://localhost:9421/e2e/harness.html")
await page.waitForSelector(".cm-content", { timeout: 30000 })
await page.evaluate(text => {
  const view = window.__view
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  // 光标回文档头，避免文末 blockSelected 边界态
  view.dispatch({ selection: { anchor: 0 } })
}, doc)
await page.waitForTimeout(800)

const initial = await page.evaluate(() => ({
  contentHeight: window.__view.contentHeight,
  lines: window.__view.state.doc.lines,
}))

await page.evaluate(async () => {
  const scroller = document.querySelector(".cm-scroller")
  const step = scroller.clientHeight * 0.8
  for (let top = 0; top <= scroller.scrollHeight; top += step) {
    scroller.scrollTop = top
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  }
  scroller.scrollTop = 0
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
})
await page.waitForTimeout(500)

const final = await page.evaluate(() => ({
  contentHeight: window.__view.contentHeight,
}))
console.log(JSON.stringify({
  file: file.split("/").pop(),
  chars: doc.length,
  lines: initial.lines,
  initialContentHeight: Math.round(initial.contentHeight),
  finalContentHeight: Math.round(final.contentHeight),
  underestimate: `${((1 - initial.contentHeight / final.contentHeight) * 100).toFixed(1)}%`,
}, null, 2))
await browser.close()
