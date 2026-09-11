// 一次性标定工具（不进 CI）：真实 Chromium + 真实 styles.css 布局，量块 widget
// 的实际渲染高度，校准 packages/engine/src/decorations/widgetHeights.ts 的估算
// 常数。用法：先起 vite dev server（9420），再 `node e2e/calibrate-heights.mjs`。
import { chromium } from "@playwright/test"

const TABLE_20 = [
  "| h1 | h2 | h3 | h4 |",
  "|---|---|---|---|",
  ...Array.from({ length: 20 }, (_, i) => `| 单元格${i}甲 | cell ${i} b | 内容第三列 ${i} | d${i} |`),
].join("\n")

const CODE_30 = ["```js", ...Array.from({ length: 30 }, (_, i) => `const value${i} = ${i};`), "```"].join("\n")

const doc = [
  TABLE_20,
  "",
  "间隔段落文本。",
  "",
  CODE_30,
  "",
  "结尾文本。",
].join("\n")

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
await page.goto(`http://localhost:9420/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
await page.waitForSelector(".omd-table table", { timeout: 15000 })
await page.waitForTimeout(400) // renderInto 微任务 + KaTeX 等无关；表格同步渲染

// 代码块在首屏视口外（表格 900px 几乎占满）——把光标放到代码块之后的文本并
// scrollIntoView（光标进入代码块会触发 blockSelected 卸载 widget），使其绘制。
await page.evaluate(() => {
  const view = window.__view
  const anchor = view.state.doc.toString().indexOf("结尾文本")
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
})
await page.waitForSelector(".omd-code pre", { timeout: 15000 })
await page.waitForTimeout(800) // Shiki 异步高亮完成

const metrics = await page.evaluate(() => {
  const view = window.__view
  const content = document.querySelector(".cm-content")
  const font = getComputedStyle(content).fontSize
  const lineHeight = view.defaultLineHeight
  const tableWrap = document.querySelector(".omd-table")
  const tableEl = document.querySelector(".omd-table table")
  const firstRow = tableEl?.querySelector("tbody tr")
  const headerRow = tableEl?.querySelector("thead tr")
  const codeWrap = document.querySelector(".omd-code")
  const codePre = document.querySelector(".omd-code pre")
  return {
    font,
    defaultLineHeight: lineHeight,
    table: tableWrap ? {
      wrapHeight: tableWrap.getBoundingClientRect().height,
      tableHeight: tableEl.getBoundingClientRect().height,
      headerHeight: headerRow.getBoundingClientRect().height,
      rowHeight: firstRow.getBoundingClientRect().height,
      rows: tableEl.querySelectorAll("tbody tr").length,
    } : null,
    code: codeWrap ? {
      wrapHeight: codeWrap.getBoundingClientRect().height,
      preHeight: codePre.getBoundingClientRect().height,
      lines: codePre.querySelectorAll("span.line").length || 1,
    } : null,
  }
})
console.log(JSON.stringify(metrics, null, 2))
await browser.close()
