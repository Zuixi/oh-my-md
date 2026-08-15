# 11 Export Pipeline

**日期：** 2026-08-16  
**状态：** 已确认  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

导出 HTML / PDF / PNG 时，公式、代码高亮、表格单元格与预览一致；PDF/PNG 等待渲染完成再捕获。

## 非目标

- 不做 DOCX / Epub / 自定义模板商店。
- 不把编辑器 DOM 截屏当导出。
- 不内嵌远程 http 图片为 data URL（只内嵌已解析的本地相对路径；失败则保留原 src）。

## 当前证据

- `packages/engine/src/export/html.ts`：`exportHtml` 同步；`MathBlock`/`InlineMath` 输出 `<code>`；围栏代码无 Shiki；无 Mermaid SVG。
- `apps/desktop/src/appExportActions.ts`：HTML 写文件；PDF/PNG 把该 HTML 交给 `export_preview`。
- 预览 widget 已用 KaTeX / Shiki / Mermaid。

## 用户流程

1. Export HTML：自包含 HTML（内联 KaTeX CSS 链接可保留 CDN 或内联已渲染 math HTML）。数学为 KaTeX HTML，代码为 Shiki HTML，Mermaid 为 SVG 或失败时 `<pre>`+错误。
2. Export PDF/PNG：同一 HTML，WKWebView 等到 `document.fonts.ready` 与 `window.__omdExportReady === true` 再 `createPDF`。

## 接口

保留同步 `exportHtml(state)` 给现有测试（结构投影，可逐步让 math/code 也变好）。新增：

```ts
export async function exportRichHtml(
  state: EditorState,
  options?: {
    resolveImageSrc?: (src: string) => string
  },
): Promise<string>
```

实现：基于同一 AST walker；math 调 KaTeX（与 widget 相同，失败则 escape 原文）；fence 调现有 Shiki highlighter；` ```mermaid ` 调 mermaid.render，失败则 pre。包一层：

```html
<!doctype html><html><head>
<meta charset="utf-8"><title>oh-my-md</title>
<style>/* 最小正文样式 */</style>
</head><body>…<script>window.__omdExportReady = true</script></body></html>
```

Mermaid/Shiki 异步；函数必须在返回前设好 ready 标记。

桌面 `exportCurrent` 改为 `await exportRichHtml`。Rust `export_preview` 在加载后轮询 `__omdExportReady`（最多 5s），超时仍导出并在前端 toast 警告。

## 测试

引擎：含 `$a$` 的文档 rich 导出含 `katex` 或 math HTML，不含把公式只包在光秃 `<code>$a$</code>`；js fence 含 shiki class 或 `style`；非法 mermaid 含原文。

桌面：`exportCurrent` mock 断言调用 rich 而不是同步瘦 HTML。

## 文档

`docs/manual-qa.md` 导出条改为检查公式/代码/图。
