# 跨平台高清 PNG 导出设计

**日期：** 2026-11-11  
**状态：** 已实现（v0.1.x）  
**父设计：** `2026-08-10-oh-my-md-design.md`、`2026-08-18-27-cross-platform-design.md`

## 目标

让 macOS、Windows、Linux 都把当前 Markdown 文档导出为**原生高分辨率 PNG**，而不是把 1x 截图放大。默认 800 CSS px × 2x = 1600 px 宽，支持 1x/2x/3x 与 640/800/1200/1920 CSS px 宽度。HTML/PDF 继续共用同一份自包含文档模型；PDF 仍仅 macOS。

## 契约

- **单一文档模型**：`@omd/engine` 的 `exportRichHtml` 生成自包含 HTML（KaTeX CSS/woff2、Shiki、Mermaid、图片 data URL、显式主题）。Rust 只追加打印页边距，不重新解析 Markdown。
- **像素定义**：输出宽 = `width_css × scale`，高 = `measured_height_css × scale`。禁止先 1x 截图再放大。
- **IPC**：`export_preview(html, path, format, scale, width) -> ExportWarning|null`。前端负责路径选择、图片内联、进度/错误提示；Rust 负责校验路径、渲染、原子写入和告警。
- **告警不是失败**：`height-clamped`（受单边 16383 px 或 32M 像素面积预算限制）与 `partial-render`（字体/图片未在页面时限内完成）会写入文件并返回告警；前端以可操作文案展示。
- **失败不落盘**：渲染、格式校验或尺寸校验失败时不写目标文件；绝不输出 1x 模糊图冒充高清图。

## 平台后端

| 平台 | 机制 | 高清关键点 |
|---|---|---|
| macOS | WKWebView 离屏窗口 → `createPDF` → `NSBitmapImageRep` 按 scale 重绘 | PDF 是矢量，按目标像素栅格化；与屏幕 DPI 无关 |
| Windows | WebView2 离屏窗口 + CDP `Page.captureScreenshot` | `clip.scale` 让 Chromium 按目标像素重绘；校验 PNG 宽高 |
| Linux | WebKitGTK 离屏窗口 + `snapshot(FullDocument)` | 窗口加宽并设置 `zoom = scale / gdk_scale`，保持 CSS 宽度不变；两帧 relayout 握手后截图；校验宽高 |

Windows 共享 WebView2 user-data 目录，所有 webview 必须使用与主窗口相同的 `additionalBrowserArgs`（见 `gotchas-desktop.md`）。导出 HTML 通过单次 token 的 `omd-export://` 自定义协议提供，捕获完成即删除。

## 尺寸与资源上限

- 宽度 320–1920 CSS px；scale 1–3；设备宽度上限 16,383 px。
- PNG 面积上限 32,000,000 设备像素（约 128 MiB RGBA），过高文档按比例截断高度并返回 `height-clamped`。
- HTML 上限 32 MiB；单图 10 MiB、整篇图片原始字节 16 MiB，超过则中止并给出图片级错误。
- 导出页等待字体与图片解码最多约 4.5 s；超时仍导出并标记 `partial-render`。

## 失败与并发

- 前端同一时刻只允许一个导出；进度 toast 在整个准备/渲染期间保持，结束或失败后关闭。
- 保存对话框默认建议文档同目录、同 stem 的文件（`note.md → note.png`）；未保存草稿使用 `export.<format>`。
- 未保存文档中的相对图片无法解析时直接报错，提示先保存，避免产出缺图的“成功”文件。
- 本地图片读取失败、非图片、单图/总量超限、读取超时使用带 `src` 的结构化错误，前端本地化展示。每次图片读取有 15 s 超时，避免网络盘挂起时永久占用导出单飞锁。
- 远程图片由引擎在渲染时通过 `onRemoteImage` 上报（含引用式与表格内图片）；页面内图片解码失败会置 `__omdExportIncomplete`，以 `partial-render` 告警而不是静默缺图。
- 自定义 CSS 中的 `</style` 必须转义，防止用户 CSS 提前关闭样式元素并注入标记；导出窗口 CSP 不应被视为隔离边界。
- `height-clamped` / `partial-render` 时文件已写入，使用警告 toast，不伪装成失败；其他错误才走红错误 toast。
- macOS 导出在 20 s 主队列 deadline 关闭离屏窗口并从活跃集合移除 delegate；22 s 通道超时仅作后备，不缩短既有导出时限。

## 验证

- CI 三平台冒烟：同一 `export-smoke` 二进制调用真实的 `export_preview` 命令体（路径校验、原子写入、平台后端）并输出 `EXPORT_SMOKE_OK width=1600 height=1200 scale=2`；Linux 在 Xvfb + dbus 下运行。
- 单元测试：尺寸/夹取、Windows CDP 参数与 PNG 解码、Linux 缩放数学、路径/格式校验、HTML 体积、图片读取超时/解码失败告警、自定义 CSS 转义、TS↔Rust 导出限制漂移、WebView2 参数漂移。
- 人工：`docs/manual-qa.md` 的高清 PNG 清单，重点看 1 CSS px 线条在 2x/3x 下的像素宽度、长文档截断告警、三平台菜单与错误提示。
