# oh-my-md

一个对标 Typora 的开源桌面 Markdown 编辑器。基于 CodeMirror 6 Live Preview 与 Tauri 2，主打大文档性能与 AI 原生。

## 特性

- Live Preview + 源码模式（`⌘E`），语法标记折叠，所见即所得
- CommonMark + GFM 全量：表格、任务列表、脚注、删除线
- 扩展：KaTeX 公式、Mermaid 图表、代码高亮、`==高亮==`、gemoji
- 图片粘贴 / 拖放 / 文件选择，写入本地 `assets/`
- 多标签、文件树、大纲、文件夹搜索、最近文件、命令面板（`⇧⌘P`）
- 冲突安全保存、崩溃恢复、会话恢复
- 导出 HTML / PDF / PNG（公式、代码、图表与预览一致）
- 亮/暗主题、自定义 CSS、Typewriter / Focus 模式

## 安装

> v1 仅支持 macOS。

```sh
pnpm install
```

## 开发

```sh
pnpm dev        # 启动 Tauri 开发窗口
pnpm verify     # 测试 + 构建（引擎 / 桌面 / Rust）
```

## 测试

```sh
pnpm test                                   # 引擎（tsc + Vitest）
pnpm --filter @omd/desktop test             # 桌面（tsc + Vitest）
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml  # Rust
```

## 发布

<!-- 由 13-B Release Engineering 补齐 -->

## License

[Apache-2.0](./LICENSE)
