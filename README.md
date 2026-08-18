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

> **开发前置**：本地开发目前仅支持 macOS（需 pnpm 与 Rust 工具链）。项目面向 macOS / Windows / Linux 三平台，Linux 本地开发与 CI 自 P1 起、Windows 自 P2 起（跨平台计划推进中；三 OS 矩阵首次真实运行观察待推送后进行）；期间导出 PDF / 图片仅 macOS 可用。

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

**版本单一来源：** `apps/desktop/src-tauri/tauri.conf.json` 的 `version` 字段。升版本用：

```sh
pnpm release:version 0.2.0   # 同步四处版本号（conf / Cargo.toml / 两个 package.json）
pnpm release:changelog       # 从 conventional commits 生成 CHANGELOG
```

**本机构建打包产物：**

```sh
pnpm --filter @omd/desktop tauri build   # 产出 .app / .dmg（bundle 含 .md 文件关联与更新签名材料）
```

**CI：** 每次 push / PR 跑四个 job（engine / desktop / rust / link，见 `.github/workflows/ci.yml`）。发布产物流水线（签名公证 + GitHub Release + `latest.json`）阻塞于 Apple Developer 账号审批，解锁清单见 [13-B 计划](./docs/superpowers/plans/2026-08-16-13b-release-cicd.md)。updater 签名私钥已配入 GitHub secrets（`TAURI_SIGNING_PRIVATE_KEY`）；`tauri.conf.json` 已含 updater 公钥与 `createUpdaterArtifacts`，release CI 产出 `latest.json` 后应用内「检查更新…」即可端到端生效。

## License

[Apache-2.0](./LICENSE)
