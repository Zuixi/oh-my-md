# 13-A Release Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地发布工程的本地可验证部分：Apache-2.0 许可证与 README、版本单一来源、自动 CHANGELOG、结构化日志、脱敏诊断包、更新检查封装。

**Architecture:** 全部在本地可 TDD 或可 review 验证，不依赖 Apple 凭据与真实 CI。版本以 `tauri.conf.json` 为单一来源；日志走 `tauri-plugin-log`；诊断包是 Rust 窄命令 + 纯函数脱敏；更新封装只做「检查→提示→触发下载」，不静默升级。

**Tech Stack:** Bash + Node（同步脚本）、Vitest（漂移测试）、git-cliff（CHANGELOG）、tauri-plugin-log、tauri-plugin-updater、cargo test。

**Spec:** `docs/superpowers/specs/2026-08-16-13-release-engineering-design.md`

## Global Constraints

- 最低 macOS 12。
- License 为 Apache-2.0。
- 版本单一来源 = `apps/desktop/src-tauri/tauri.conf.json` 的 `version`；需同步的 4 处为：根 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/Cargo.toml`、`tauri.conf.json`。`packages/engine/package.json` 无 `version`（workspace-only，不做同步）。
- CHANGELOG 由 conventional commits 自动生成（`.githooks/commit-msg` 已强制 `<type>: <why>`）。
- 更新策略 = 检查 → 提示 → 触发下载，绝不静默升级。
- 密钥不进仓库、不进日志；诊断包不含文档正文、不落剪贴板与密钥。
- 不引入 E2E、不做 Windows/Linux、不上 App Store、无遥测。
- 验证命令：`pnpm test`、`pnpm --filter @omd/desktop test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。

---

### Task A1: License + README 骨架

**Files:**
- Create: `LICENSE`（Apache-2.0 全文，含版权行 `Copyright 2026 oh-my-md contributors`）
- Create: `README.md`

**Interfaces:** 无。

- [ ] **Step 1: 写入 `LICENSE`**（Apache License 2.0 标准全文）
- [ ] **Step 2: 写入 `README.md` 骨架**——标题、一句话简介（对标 Typora 的开源桌面 Markdown 编辑器，CM6 Live Preview + Tauri 2）、安装（`pnpm install`）、开发（`pnpm dev`）、测试（`pnpm verify`）。发布流程一节留空，注明由 13-B 补齐。
- [ ] **Step 3: Commit** `docs: add Apache-2.0 license and README`

---

### Task A2: 版本单一来源 + 同步脚本 + 漂移测试

**Files:**
- Create: `scripts/sync-version.sh`
- Create: `apps/desktop/test/versionSync.test.ts`
- Modify: `package.json`（scripts 增 `"release:version": "bash scripts/sync-version.sh"`）

**Interfaces:**
- `scripts/sync-version.sh <x.y.z>`：把 4 处版本号改为 `<x.y.z>`。JSON 用 `node -e`（parse → 改 `version` → stringify 回写），`Cargo.toml` 用 `sed` 替换 `^version = ".*"`。
- 漂移测试断言 4 处 `version` 与 `tauri.conf.json` 一致（复用 `apps/desktop/test/crossLayerConstants.test.ts` 的 `readFileSync` + 解析手法）。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/versionSync.test.ts`——读 4 个文件、解析 version，断言彼此相等；再断言 `scripts/sync-version.sh` 存在且可执行（`test("version fields agree", ...)`）。
- [ ] **Step 2: 运行确认失败** `pnpm --filter @omd/desktop test versionSync`；预期 FAIL（脚本不存在 / 断言未覆盖同步逻辑）。
- [ ] **Step 3: 实现 `scripts/sync-version.sh`**——参数校验 `^[0-9]+\.[0-9]+\.[0-9]+$`；更新 4 处；末尾打印改动的 4 个文件路径。
- [ ] **Step 4: 运行确认通过** `pnpm --filter @omd/desktop test versionSync`；并手工 `bash scripts/sync-version.sh 0.1.0`（幂等，无 diff）。
- [ ] **Step 5: Commit** `feat: single-source version with sync script and drift test`

---

### Task A3: CHANGELOG 自动生成（git-cliff）

**Files:**
- Create: `cliff.toml`
- Create: `scripts/changelog.sh`
- Modify: `package.json`（scripts 增 `"release:changelog": "bash scripts/changelog.sh"`）
- Create: `CHANGELOG.md`（由脚本首次生成）

**Interfaces:**
- `scripts/changelog.sh`：`git cliff -o CHANGELOG.md`（用本仓库 `git log` 的 conventional commits 生成）。
- `cliff.toml`：`conventional_commits = true`；`commit_parsers` 映射 `feat`/`fix`/`refactor`/`docs`/`test`/`chore`/`perf`/`ci`（与 `.githooks/commit-msg` 允许的 type 对齐）；`tag_pattern` 用 `v[0-9].*`。

- [ ] **Step 1: 安装 dev 工具** `git cliff` 作为一次性 CLI 使用（不进 Cargo/pnpm 依赖；计划里记录其安装方式），或 `cargo install git-cliff`。
- [ ] **Step 2: 写 `cliff.toml`**——提交解析器与 tag pattern 见 Interfaces。
- [ ] **Step 3: 写 `scripts/changelog.sh`**——`set -euo pipefail`；`git cliff -o CHANGELOG.md`。
- [ ] **Step 4: 生成验证** `bash scripts/changelog.sh` 后 `CHANGELOG.md` 含 `0d6c583` 以来的历史条目（`feat`/`fix` 分组正确）。
- [ ] **Step 5: Commit** `feat: generate CHANGELOG from conventional commits`

---

### Task A4: 结构化日志（tauri-plugin-log）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（增 `tauri-plugin-log = "2"`）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`.plugin(tauri_plugin_log::Builder::new().build())`，在 `.manage(...)` 前）
- Create: `apps/desktop/src-tauri/src/logging.rs`（可选：`pub fn init<R: Runtime>(app)` 封装，保持 `lib.rs` 薄）

**Interfaces:**
- `tauri_plugin_log::Builder::new().targets([LogTarget::LogDir, LogTarget::Stdout]).build()`：写 `$HOME/Library/Logs/{bundle_identifier}/` 下滚动日志 + stdout。
- Rust 侧后续用 `log::info!/warn!/error!`（`tauri-plugin-log` 依赖 `log` crate）。

- [ ] **Step 1: 加依赖并注册插件**——`Cargo.toml` 增 `tauri-plugin-log = "2"`；`lib.rs` `.plugin(tauri_plugin_log::Builder::new().build())`。
- [ ] **Step 2: 在 `menu::install` 或 `run()` 加一条 `log::info!("app started {}", env!("CARGO_PKG_VERSION"))`**，验证日志路径落盘。
- [ ] **Step 3: 运行确认** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过；`pnpm dev` 启动后 `~/Library/Logs/md.ohmy.desktop/` 出现日志文件。
- [ ] **Step 4: Commit** `feat: structured logging via tauri-plugin-log`

---

### Task A5: 诊断包导出（export_diagnostics）

**Files:**
- Create: `apps/desktop/src-tauri/src/diagnostics.rs`（脱敏纯函数 + 收集逻辑）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod diagnostics;` + 注册 `diagnostics::export_diagnostics`）
- Modify: `apps/desktop/src/desktopServices.ts`（增 `exportDiagnostics?: () => Promise<void>` 及 invoke 封装）
- Modify: `apps/desktop/src/commands.ts`（增 command id，接入菜单/命令面板，可选）

**Interfaces:**
- `pub fn redact_line(line: &str) -> String`：纯函数，脱敏一行日志（把 `$HOME` 展开为 `<home>`、把 `file:///...` 前缀剥成文件名）。**这是单测靶点。**
- `#[tauri::command] fn export_diagnostics(app: tauri::AppHandle, path: String) -> Result<(), String>`：收集日志目录文件 + 版本 + macOS 版本到 zip，写到 `path`；无日志时仍成功（空包）。
- TS：`services.exportDiagnostics?: () => Promise<void>` → `invoke("export_diagnostics", { path })`，路径由 `pickSavePath` 选择。

- [ ] **Step 1: 写失败测试** `diagnostics.rs` 内 `#[cfg(test)]`——`redact_line("/Users/x/notes/a.md")` 不含 `/Users/x`；`redact_line("file:///Users/x/a.png")` 只含 `a.png`；无日志时 `export_diagnostics` 不 panic（用 `tempfile` 指向空目录）。
- [ ] **Step 2: 运行确认失败** `cargo test export_diagnostics`；预期 FAIL。
- [ ] **Step 3: 实现** `redact_line` + `export_diagnostics`（读日志目录、拼 zip，`tauri` 的 `path` 参数校验）。
- [ ] **Step 4: 运行确认通过** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- [ ] **Step 5: 前端接线** `desktopServices.ts` 加 `exportDiagnostics`；`App.tsx` commands 加 `id: "export-diagnostics"`（label `Export Diagnostics…`）。
- [ ] **Step 6: Commit** `feat: export redacted diagnostics bundle`

---

### Task A6: 更新检查封装（tauri-plugin-updater）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（增 `tauri-plugin-updater = "2"`）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`.plugin(tauri_plugin_updater::Builder::new().build())`）
- Modify: `apps/desktop/package.json`（增 `@tauri-apps/plugin-updater`）
- Modify: `apps/desktop/src/desktopServices.ts`（增 `checkForUpdates`）
- Create: `apps/desktop/test/updater.test.ts`

**Interfaces:**
- `checkForUpdates(): Promise<{ version: string; currentVersion: string } | null>`：调 `@tauri-apps/plugin-updater` 的 `check()`，有新版本返回 `{ version, currentVersion }`，无/失败返回 `null`（失败静默，不打断编辑）。
- 本轮**只封装 check**，不接 UI 提示（提示与下载留给 13-B 的更新清单就绪后）。

- [ ] **Step 1: 写失败测试** `updater.test.ts`——mock `@tauri-apps/plugin-updater` 的 `check`；断言有新版本返回正确形状、无版本返回 `null`、抛错返回 `null`。
- [ ] **Step 2: 运行确认失败** `pnpm --filter @omd/desktop test updater`；预期 FAIL。
- [ ] **Step 3: 实现** `desktopServices.ts` 的 `checkForUpdates`；注册插件与前端依赖。
- [ ] **Step 4: 运行确认通过** `pnpm --filter @omd/desktop test updater`；`cargo test` 通过。
- [ ] **Step 5: Commit** `feat: update check wrapper via tauri-plugin-updater`

---

更新 `docs/manual-qa.md`（增「发布与升级」节，含诊断导出与更新检查条目）。
