# 19 暗色代码主题（Shiki 双主题）设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`（主题系统：亮/暗）
**路线图关联：** 08 Markdown Rendering Polish 的第一项（暗色代码主题）

## 目标

暗色主题下代码块不再呈现亮色背景：Live Preview 的 CodeWidget、`exportRichHtml` 导出的 HTML 代码块均按 Shiki 双主题渲染，跟随应用主题（应用内）或系统偏好（导出 HTML）切换。

## 非目标

- 用户自定义代码主题（仍固定 github-light / github-dark）。
- PDF/PNG 导出的暗色输出（导出预览按亮色打印，属既有行为）。
- 编辑态（光标在代码块内）的高亮——既有已知限制不变。

## 方案

1. **引擎渲染**：`code.ts` 与 `shikiExport.ts` 的 highlighter 同时加载 `github-light` + `github-dark`，`codeToHtml` 改用 `themes: { light, dark }` + `defaultColor: "light"`——输出内联 `color:…`（亮）与 `--shiki-dark*` CSS 变量（暗），一次渲染两主题。
2. **应用内切换**：`styles.css` 在 `html[data-theme="dark"]` 下把 `.shiki`/`.shiki span` 的颜色族映射到 `--shiki-dark*` 变量（shiki 官方暗色映射式）。无该变量的 token 回退继承/初始值。
3. **导出 HTML**：富导出文档模板注入 `@media (prefers-color-scheme: dark)` 的同一映射，导出文件随系统主题自适应。
4. 缓存 key（`lang:src`）不变——HTML 内容变化对缓存透明。

## 测试矩阵

- 引擎 `blockwidgets.test.ts`：CodeWidget 渲染输出含 `--shiki-dark` 变量。
- 引擎 `export-rich.test.ts`：富导出含 `--shiki-dark` 与 `prefers-color-scheme` 样式块。
- 桌面 `crossLayerConstants.test.ts` 不适用（无新跨层常量；CSS 变量名由 Shiki 产出，非本仓库所有）。

## 手动 QA

manual-qa.md M2 块渲染节：暗色主题下代码块背景/文字为暗色系、切亮色即回亮色；导出 HTML 在系统暗色下打开自适应。

## 对后续规格提供的接口

无新 API；双主题 HTML 形状（`--shiki-dark*` 变量）成为 08 其余项（暗色数学/表格微调）的参照。
