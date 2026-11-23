<div align="center">
  <img src="docs/images/logo.png" width="110" alt="oh-my-md 应用图标" />

# oh-my-md — 快速开源 Markdown 编辑器

**免费开源、本地优先、源码保真的所见即所得 Markdown 编辑器 —— 基于 Tauri 2 与 CodeMirror 6，75 万行大文档依然流畅。**

[**下载最新版本 →**](https://github.com/Zuixi/oh-my-md/releases/latest) · [功能](#功能) · [性能](#性能) · [快捷键](#键盘快捷键) · [文档](#文档) · [路线图](#路线图)

[English](./README.md) · 简体中文

[![CI](https://github.com/Zuixi/oh-my-md/actions/workflows/ci.yml/badge.svg)](https://github.com/Zuixi/oh-my-md/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/Zuixi/oh-my-md)](https://github.com/Zuixi/oh-my-md/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Zuixi/oh-my-md/total)](https://github.com/Zuixi/oh-my-md/releases)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20·%20Windows%20·%20Linux-black)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](./CONTRIBUTING.md)

</div>

![oh-my-md 演示：实时 Live 预览输入、⌘E 毫秒级源码切换、表格格内直接编辑与 KaTeX 公式弹窗实时编辑](docs/images/demo.gif)

<table>
  <tr>
    <td align="center"><strong>暗色主题（默认）</strong></td>
    <td align="center"><strong>亮色主题</strong></td>
  </tr>
  <tr>
    <td><img src="docs/images/hero-dark.png" alt="oh-my-md 暗色主题：文件树、大纲、表格、KaTeX 公式与 Mermaid 图表" /></td>
    <td><img src="docs/images/hero-light.png" alt="oh-my-md 亮色主题：文件树、大纲、表格、KaTeX 公式与 Mermaid 图表" /></td>
  </tr>
</table>

## 为什么做 oh-my-md？

Typora 证明了 Markdown 编辑器可以像现代文字处理器一样顺滑——然后它闭源并开始收费。MarkText 坚持了开源，但 2022 年之后就再没有发布过版本。而在今天，借助 AI 编码工具一个周末就能攒出一个 Markdown 编辑器原型——但真正拿到日常写作里，遇到五万行大文档、复杂表格、中文输入法或外部并发修改时，粗糙的原型立刻就会露馅。

**oh-my-md 专注打磨决定日常可靠性的「最难的 5%」：** 免费、Apache-2.0 开源、基于 Tauri 2 轻量外壳，从第一天起就为源码保真、数据安全与超大文档而设计。

- **真正的源码保真（干净的 Git diff）** —— Live 预览只是原始 `.md` 字节上的投影，不会像富文本 AST 编辑器那样在保存时偷偷改写列表、转义或表格；连表格格内编辑也只做字节级最小语法范围补丁。
- **架构级数据安全** —— Rust 双重校验原子保存、外部修改与符号链接冲突检测、多草稿崩溃恢复、按窗口会话恢复与本地版本快照。
- **可复现的超大文档性能** —— 按视口窗口化 Live 渲染、流式打开、编辑热路径零 O(doc) 开销：**20 MB / 75 万行文档逐键 p95 仍仅 2 ms**，内置基准随时可自测。
- **啃下最难的交互细节** —— Typora 风格的表格格内直接编辑、紧凑选区几何（跨渲染块拖选仍精确复制原始 Markdown）、来自网页/飞书/Notion/Word 的智能语义粘贴（支持 `rowspan`/`colspan` 复杂表格）、带 LaTeX 高亮的公式弹窗编辑，以及细致的中文输入法体验。
- **三平台印刷级导出** —— macOS、Windows 与 Linux 全平台支持自包含 **HTML**（内联本地图片与样式；远程图片保留 URL）、**原生分页 PDF** 与 **1x/2x/3x 高清 PNG**，与 Live 预览保持一致。

|  | oh-my-md | Typora | MarkText |
| --- | --- | --- | --- |
| 开源 | ✅ Apache-2.0 | ❌ | ✅ MIT |
| 价格 | 免费 | $14.99 | 免费 |
| Live 预览（无分栏） | ✅ | ✅ | ✅ |
| 源码保真（不重写 AST） | ✅ 原始 Markdown 投影 | — | — |
| 十万行以上仍然流畅¹ | ✅ 有实测（`bench`） | — | — |
| 导出（macOS · Windows · Linux） | HTML · 分页 PDF · 3x PNG | HTML · PDF · DOCX … | HTML · PDF |
| 外壳 | Tauri 2（原生 WebView，Windows 安装包 ~7 MB） | Electron | Electron |
| 平台 | macOS · Windows · Linux | macOS · Windows · Linux | macOS · Windows · Linux |

¹ “—”表示无公开数据或架构不同，不代表对它们的结论。

## 功能

**写作与 Live 预览**
- **真正的 Live 预览** —— 输入时语法标记自动淡出为渲染结果；随时 `⌘E` 在 1 ms 内切回纯源码模式，绝不静默改写原文
- **CommonMark + GFM 全量** —— 表格、任务列表、脚注（点击往返跳转）、删除线、`==高亮==`、`<mark>`、`<u>`、`:gemoji:` 补全
- **Typora 风格表格与智能粘贴** —— 点击渲染表格单元格即可原位编辑（字节级最小修改）；从浏览器/飞书/Notion/Word 粘贴富文本自动转为干净 Markdown，并支持 `rowspan`/`colspan` 复杂表格
- **富内容块** —— **KaTeX 数学公式**（点击弹出内置 CodeMirror LaTeX 编辑器实时预览）、**Mermaid 图表**、**Shiki 代码高亮**
- **写作打磨** —— 可配置的自动配对（括号/引号/Markdown 语法）、打字机与专注模式，以及经过仔细验证的**中文 IME** 与紧邻中文下划线（`__粗体__`）支持

**文件、工作区与数据安全**
- **单文件优先，工作区完备** —— 双击任意 `.md` 即可打开；挂载文件夹后拥有虚拟化文件树、原地新建/重命名、快速打开（`⌘P`）、正则查找替换（`⌘F` / `⌘H`）、文件夹搜索（`⇧⌘F`）、大纲面板与多标签
- **本地图片管理** —— 粘贴、拖放或选择插入图片，自动保存到文档旁的 `assets/` 目录
- **绝不丢稿** —— 冲突安全原子保存、外部变更检测、多草稿崩溃恢复、按窗口会话恢复与本地版本快照
- **隐私与按需诊断** —— 无账号、无遥测；诊断日志默认关闭，排障时可一键导出脱敏诊断包（见[日志与故障排查](./docs/guides/troubleshooting.md)）

**导出（macOS · Windows · Linux）**
- **HTML、原生分页 PDF 与 PNG** 均已支持 macOS、Windows 与 Linux，完整保留 Live 预览中的 KaTeX 公式、Shiki 代码高亮、表格（含复杂合并单元格表格）与 Mermaid 图表
- **PDF 页面设置** —— 支持 A4/Letter 纸张、纵/横向、自定义四边距、标题自动分页及可选页眉页码
- **高清 PNG** —— 可在设置中配置导出宽度（640–1920 CSS px）与 1x/2x/3x 清晰度

**外观与本地化**
- 亮色 / 暗色 / 跟随系统主题（原生标题栏与代码主题同步），内置 English / 简体中文界面
- 支持通过公开 CSS 变量自定义主题 —— 可在 `html[data-theme="dark"|"light"]` 上覆写 `--omd-bg`、`--omd-fg`、`--omd-link`、`--omd-cursor`、`--omd-selection-bg`、`--omd-selection-bg-unfocused` 以及 `--omd-syn-*` 语法调色板

## 性能

一句话承诺：**你永远不必因为编辑器卡顿而拆分文档。**

- 逐键延迟在所有基准文档上都远低于 16ms 帧预算——**20 MB / 75 万行文件源码模式 p95 也只有 2 ms**
- `⌘E` 模式切换只构建光标附近的种子——**无论文档多大都在 1ms 以内**
- 大文档采用按视口窗口化的 Live 渲染，保持编辑流畅

| 文档 | 逐键 p95（live / 源码） | 主线程打开 |
| --- | --- | --- |
| 1 万行 | 5.5 / 2 ms | 32 ms |
| 10 MB · 38 万行 | 2.5 / 2 ms² | ~15 ms |
| 20 MB · 75 万行 | — / 2 ms | ~30 ms |

² 安全模式下 Live 渲染按视口窗口化。

数据来自 M 系列开发机上的内置 advisory 基准——运行 `pnpm --filter @omd/engine bench` 即可自行复现。

## 下载

[**前往 GitHub Releases 下载最新版 oh-my-md →**](https://github.com/Zuixi/oh-my-md/releases/latest)

| 平台 | 下载文件 | 说明 |
| --- | --- | --- |
| macOS | Universal `.dmg` | 同时支持 Apple Silicon 与 Intel Mac |
| Windows x64 | `-setup.exe` | Windows 只发布这一个 NSIS 安装包；受管环境见下方说明 |
| Linux x64 | `.AppImage` 或 `.deb` | AppImage 可直接运行；deb 适用于 Debian/Ubuntu 系发行版 |

> **之前装过 MSI 版本？** 运行一次 `-setup.exe` 安装向导即可——它会引导你卸载旧的 MSI 安装；完成后桌面若出现两个图标，删除较旧的那个即可。MSI 不再随 Release 发布；受管环境（Intune / SCCM 等）可从源码自行构建：`pnpm --filter @omd/desktop tauri build --bundles msi`，详见 [docs/guides/windows-installer.md](./docs/guides/windows-installer.md)。

### 未签名安装包提示

当前版本**尚未进行代码签名**。请只从本仓库的 GitHub Releases 页面下载，并尽量用随发布提供的 `SHA256SUMS.txt` 校验文件。不要在系统范围内关闭 Gatekeeper 或 SmartScreen。

**macOS（Gatekeeper）：** 打开 `.dmg`，将 oh-my-md 拖入“应用程序”，然后尝试启动。若 macOS 拦截，请进入**系统设置 → 隐私与安全性**，确认被拦截的是 oh-my-md，再点**仍要打开**；也可以在 Finder 中按住 Control 点击应用并选择**打开**。不要运行全局关闭 Gatekeeper 的命令。

**Windows（SmartScreen）：** 若 Microsoft Defender SmartScreen 弹窗，请先确认应用名与安装包来源是本 GitHub 仓库，再点**更多信息 → 仍要运行**。不要在系统范围内关闭 SmartScreen。

### Linux

运行 AppImage：

```sh
chmod +x oh-my-md_*.AppImage
./oh-my-md_*.AppImage
```

Debian / Ubuntu 安装 deb：

```sh
sudo apt install ./oh-my-md_*.deb
```

若系统提示缺少 WebKit 或桌面库，请按 [Tauri Linux 前置条件](https://v2.tauri.app/start/prerequisites/#linux)安装对应发行版依赖。

### 自动更新

更新器就绪版本（`0.1.0` 及以后）可以使用 Tauri updater 就地升级：应用检查稳定通道，用内置 minisign 公钥校验每次下载，并且只在两次独立的用户确认之后（先确认下载、再确认重启）才安装。**绝不会静默下载。**

| 安装包 | 应用内自动安装 |
| --- | --- |
| macOS（DMG 安装的 app） | ✅ |
| Windows NSIS（`-setup.exe`） | ✅ |
| Linux AppImage | ✅ |
| Linux deb | — ¹ |

¹ deb 包会检查更新，但改为打开官方 GitHub Release 页面手动安装——updater 绝不会替换 deb 安装。历史 MSI 安装同此路径，且下载按钮会直达对应版本的 `-setup.exe`，运行一次即完成迁移（见上方说明）。

- **从 `0.0.1` 开始**：最初发布的构建无法自行更新。请先手动安装一个更新器就绪版本（`0.1.0` 或更高）；此后更高的版本即可在应用内更新。
- **updater 信任独立于安装包签名**：上面的安装包未签名（见上方警告），但 updater 本身仍然可信——每个更新包都用项目的 minisign 私钥签名，应用用内置的公钥校验签名。签名校验失败会停止安装并指向官方 GitHub Release，绝不回退到未经验证的 URL。

## 从源码构建

需要 [pnpm](https://pnpm.io/)（或 Corepack）、[Rust 工具链](https://rustup.rs/)与当前系统的 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。macOS 需 Xcode 命令行工具，Linux 需 WebKitGTK 开发库，Windows 需 Microsoft Visual Studio C++ 生成工具。

```sh
git clone https://github.com/Zuixi/oh-my-md.git
cd oh-my-md
pnpm install
pnpm dev        # 启动应用
```

在当前系统生成原生安装包：`pnpm --filter @omd/desktop tauri build`。

## 键盘快捷键

排版都在熟悉的按键上（`⌘B`、`⌘I`、`⌘1`–`⌘6`……），所有命令都能从命令面板（`⇧⌘P`）搜到——无需记忆。完整对照见[快捷键指南](./docs/guides/keyboard-shortcuts.md)。Windows 与 Linux 使用对应的 Ctrl 快捷键。

## 文档

- [键盘快捷键指南](./docs/guides/keyboard-shortcuts.md)（[English](./docs/guides/keyboard-shortcuts-en.md)）
- [日志与故障排查](./docs/guides/troubleshooting.md)（[English](./docs/guides/troubleshooting-en.md)）
- [Windows 安装包策略（NSIS / MSI）](./docs/guides/windows-installer.md)
- [安全与隐私说明](./SECURITY.md)
- [参与贡献指南](./CONTRIBUTING.md) 与 [架构 / 工程规范（`AGENTS.md`）](./AGENTS.md)

## 路线图

- [ ] macOS 与 Windows 签名安装包（Apple Developer / Windows Authenticode 账号仍未就绪）
- [x] 自动更新——更新器就绪版本（`0.1.0+`）由 minisign 校验的 Tauri updater 提供
- [ ] 块级 AI 操作（润色 / 续写 / 翻译），支持 OpenAI 兼容接口与本地 Ollama
- [ ] 插件架构——设计已预留边界

## 常见问题

- **真的免费吗？** 是。Apache-2.0 开源，无账号、无功能门槛。
- **我的数据在哪里？** 就是磁盘上的普通 `.md` 文件——任何内容都不会上传。
- **支持 Windows / Linux 吗？** 三平台均已支持，安装包见上方下载表。
- **能打开我现有的笔记吗？** 只要是 Markdown 就行——CommonMark + GFM，外加 `==高亮==`、脚注、KaTeX 公式、Mermaid 等常用扩展。
- **AI 功能呢？** 设计已完成、尚未发布——见[路线图](#路线图)。

## 参与贡献

欢迎 Issue 与 PR！开发环境、分域测试矩阵与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文）。提 PR 前请确保 `pnpm verify` 通过。

## 致谢

站在优秀开源项目的肩膀上：[CodeMirror 6](https://codemirror.net/) 与 [Lezer](https://lezer.codemirror.net/)、[Tauri](https://tauri.app/)、[KaTeX](https://katex.org/)、[Mermaid](https://mermaid.js.org/)、[Shiki](https://shiki.style/)、[React](https://react.dev/)、[Vite](https://vite.dev/)。Typora 的交互设计是长期的灵感来源。

## 许可证

[Apache-2.0](./LICENSE)
