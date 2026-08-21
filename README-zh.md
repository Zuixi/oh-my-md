<div align="center">
  <img src="docs/images/logo.png" width="110" alt="oh-my-md 应用图标" />

# oh-my-md

**免费开源、真正所见即所得的 Markdown 编辑器 —— 为几十万行的大文档保持流畅而设计。**

[English](./README.md) · 简体中文

[![CI](https://github.com/Zuixi/open-md/actions/workflows/ci.yml/badge.svg)](https://github.com/Zuixi/open-md/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20·%20Windows%20·%20Linux-black)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](./CONTRIBUTING.md)

<!-- TODO(repo-rename): 仓库改名为 oh-my-md 后，更新仓库相关链接（badge、clone、Releases）。 -->
</div>

![oh-my-md：暗色主题，文件树与大纲，Live 预览渲染 KaTeX 公式与 Mermaid 图表](docs/images/hero.png)

<!-- TODO(demo-gif): 录一段 10–15 秒演示 GIF（⌘E Live⇄源码切换 + 打字），存为 docs/images/demo.gif 后取消下一行注释。
![演示：⌘E 在 Live 预览与源码模式间切换](docs/images/demo.gif)
-->

## 为什么做 oh-my-md？

Typora 证明了 Markdown 编辑器可以像现代文字处理器一样顺滑——然后它闭源并开始收费。MarkText 坚持了开源，但 2022 年之后就再没有发布过版本。**oh-my-md 是一次新的尝试：免费、Apache-2.0 开源、Tauri 轻量外壳，编辑引擎从第一天起就为大文档而设计。**

|  | oh-my-md | Typora | MarkText |
| --- | --- | --- | --- |
| 开源 | ✅ Apache-2.0 | ❌ | ✅ MIT |
| 价格 | 免费 | $14.99 | 免费 |
| Live 预览（无分栏） | ✅ | ✅ | ✅ |
| 十万行以上仍然流畅¹ | ✅ 有实测 | — | — |
| 导出 | HTML · PDF · PNG | HTML · PDF · DOCX … | HTML · PDF |
| 外壳 | Tauri 2 | Electron | Electron |
| 平台 | macOS · Windows · Linux | macOS · Windows · Linux | macOS · Windows · Linux |

¹ "—" 表示无公开数据，不代表对它们的结论。

## 功能

**写作**
- **真正的 Live 预览** —— 输入时语法标记自动淡出为渲染结果；随时 `⌘E` 切回纯源码模式
- **CommonMark + GFM 全量** —— 表格、任务列表、脚注、删除线
- **富内容块** —— KaTeX 公式、Mermaid 图表、Shiki 代码高亮、`==高亮==`、`:gemoji:`
- **打字机 / 专注模式**，中文等 CJK 输入法行为经过仔细处理

**文件与工作区**
- 以单文件为中心——双击任意 `.md` 即可打开；挂载文件夹工作区后获得文件树、文件夹搜索、大纲面板与多标签
- 粘贴 / 拖放 / 选择插入图片，自动保存到文档旁的 `assets/` 目录
- 冲突安全保存、外部变更检测、崩溃与会话恢复

**导出**
- HTML / PDF / PNG，与 Live 预览所见一致——公式、代码、图表原样带出

**外观**
- 亮 / 暗主题（代码主题跟随），支持自定义 CSS

## 性能

一句话承诺：**你永远不必因为编辑器卡顿而拆分文档。**

- 逐键延迟在所有基准文档上都远低于 16ms 帧预算——**20 MB / 75 万行文件源码模式 p95 也只有 2 ms**
- `⌘E` 模式切换只构建光标附近的种子——**无论文档多大都在 1ms 以内**
- 超过 5 万行的文档自动进入安全模式（默认源码视图、live 渲染按视口窗口化、本次会话内记住你的选择），编辑保持流畅——随时可手动切回 live

| 文档 | 逐键 p95（live / 源码） | 主线程打开 |
| --- | --- | --- |
| 1 万行 | 5.5 / 2 ms | 32 ms |
| 10 MB · 38 万行 | 2.5 / 2 ms² | ~15 ms |
| 20 MB · 75 万行 | — / 2 ms | ~30 ms |

² 安全模式下 live 渲染按视口窗口化。

数据来自 M 系列开发机上的内置 advisory 基准——运行 `pnpm --filter @omd/engine bench` 即可自行复现。

## 安装

oh-my-md 当前为 **v0.1.0**，支持 **macOS、Windows 和 Linux**。

**下载** —— 安装包将在发布流水线就绪后上架 [Releases](https://github.com/Zuixi/open-md/releases) 页面；在那之前，源码构建大约需要五分钟。

**源码构建** —— 需要 [pnpm](https://pnpm.io/)（或 Corepack）与 [Rust 工具链](https://rustup.rs/)。各平台额外依赖：macOS 需 Xcode 命令行工具（`xcode-select --install`），Linux 需 `libwebkit2gtk` 等（见 [Tauri Linux 前置条件](https://v2.tauri.app/start/prerequisites/#linux)），Windows 需 Visual Studio C++ 生成工具。

```sh
git clone https://github.com/Zuixi/open-md.git   # 仓库即将改名为 oh-my-md
cd open-md
pnpm install
pnpm dev        # 启动应用
```

本地打包 `.app` / `.dmg`：`pnpm --filter @omd/desktop tauri build`。

## 键盘快捷键

排版都在熟悉的按键上（`⌘B`、`⌘I`、`⌘1`–`⌘6`……），所有命令都能从命令面板（`⇧⌘P`）搜到——无需记忆。完整对照见[快捷键指南](./docs/guides/keyboard-shortcuts.md)。

## 路线图

- [ ] 签名 + 自动更新的发布
- [ ] 块级 AI 操作（润色 / 续写 / 翻译），支持 OpenAI 兼容接口与本地 Ollama
- [ ] 插件架构——设计已预留边界

## 常见问题

- **真的免费吗？** 是。Apache-2.0 开源，无账号、无功能门槛。
- **我的数据在哪里？** 就是磁盘上的普通 `.md` 文件——任何内容都不会上传。
- **支持 Windows / Linux 吗？** 三平台均已支持。
- **能打开我现有的笔记吗？** 只要是 Markdown 就行——CommonMark + GFM，外加 `==高亮==`、脚注、KaTeX 公式、Mermaid 等常用扩展。
- **AI 功能呢？** 设计已完成、尚未发布——见[路线图](#路线图)。

## 参与贡献

欢迎 Issue 与 PR！开发环境、分域测试矩阵与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文）。提 PR 前请确保 `pnpm verify` 通过。

## 致谢

站在优秀开源项目的肩膀上：[CodeMirror 6](https://codemirror.net/) 与 [Lezer](https://lezer.codemirror.net/)、[Tauri](https://tauri.app/)、[KaTeX](https://katex.org/)、[Mermaid](https://mermaid.js.org/)、[Shiki](https://shiki.style/)、[React](https://react.dev/)、[Vite](https://vite.dev/)。Typora 的交互设计是长期的灵感来源。

## 许可证

[Apache-2.0](./LICENSE)
