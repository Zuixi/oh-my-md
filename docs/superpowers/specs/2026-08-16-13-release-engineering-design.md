# 13 Release Engineering

**日期：** 2026-08-16  
**状态：** 待用户审核  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

把「`pnpm dev` 能跑的代码」变成「别人能下载、安装、打开、自动升级、报障可定位」的 macOS 产品。具体交付六件事：

1. **CI** —— push 即跑引擎测试、桌面测试、Rust 测试、前端构建、Rust 二进制链接，失败阻断合并。
2. **版本同步** —— `package.json` / `Cargo.toml` / `tauri.conf.json` 三处版本号单一来源，发版一条命令同步，并有漂移测试防止再次失配。
3. **macOS 签名 + 公证** —— 发布的 `.app` / `.dmg` 通过 Gatekeeper，不弹「无法验证开发者」。
4. **安装烟测** —— 每版产物在干净环境走「下载 → 挂载/解压 → 打开 → 建/存一个 .md」全链路。
5. **自动更新** —— 用户无需重装即可拿到新版本（`tauri-plugin-updater` + 静态更新清单）。
6. **结构化日志 + 诊断包** —— 崩溃与运行日志可收集、可脱敏、可一键导出。

## 非目标

- **不引入完整 E2E 套件**（路线图已定）：发布门槛 = 自动化单元/集成检查 + Rust 测试 + 前端构建 + 安装烟测 + 人工 QA。
- 不做 Windows / Linux 打包（v1 只 macOS）。
- 不上 Mac App Store（只走 GitHub Releases 直签公证）。
- 不引入遥测 / 分析 SDK；日志仅在用户主动导出诊断包时离场。
- 不做强制最低 macOS 版本以外的兼容矩阵（只声明支持的最低版本）。

## 当前证据

- **无 CI**：无 `.github/`、`.gitlab-ci.yml` 等任何 CI 配置。质量门靠本地 `pnpm verify`（`scripts/test.sh` + `scripts/build.sh`）与 `.githooks/` 的 `pre-commit`。
- **版本三处硬编码且未同步**：`package.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/tauri.conf.json` 均为 `0.1.0`，无同步脚本、无漂移测试。
- **签名/公证未配置**：`tauri.conf.json` 的 `bundle` 只有 `active`、`targets: "all"`、`icon`，无 `macOS` 签名配置，无 `createUpdaterArtifacts`。`identifier` 为 `md.ohmy.desktop`。
- **无自动更新**：`Cargo.toml` 仅 `tauri-plugin-opener` / `tauri-plugin-dialog`，无 `tauri-plugin-updater`。
- **无结构化日志**：无 `tauri-plugin-log`；现有日志为 Rust `eprintln!` / 前端 `window.alert`。
- **无 README / CHANGELOG**：仓库根无 `README.md`、无 `CHANGELOG.md`。
- **构建入口已就绪**：`scripts/build.sh`（前端 + Rust 二进制链接）与 `scripts/test.sh` 可被 CI 复用；`pnpm --filter @omd/desktop tauri build` 是打包入口。

## 用户流程

**开发者发版**
1. push PR → CI 全绿（引擎/桌面/Rust 测试 + 前端构建 + 二进制链接）→ 合并。
2. 跑一条版本命令（如 `pnpm release:version 0.2.0`）→ 三处版本号同步 + 生成 CHANGELOG 草稿。
3. 打 tag（`v0.2.0`）→ CI 的 release job：`tauri build` 签名 + 公证 → 产出 `.app` / `.dmg` / 更新清单 → 挂到 GitHub Release。
4. 烟测脚本（或人工清单）在干净环境验证产物 → 发布。

**用户安装与升级**
5. 下载 `.dmg` → 双击挂载（Gatekeeper 通过，因为已签名+公证）→ 拖入 Applications → 打开。
6. 版本 `0.2.1` 发布后，旧版本启动时检查更新清单 → 提示可升级 → 下载并替换（或跳转下载页）。

**用户报障**
7. 崩溃 / 出 bug → 用户从菜单「Export Diagnostics…」导出诊断包（日志 + 版本 + 系统信息，已脱敏）→ 附到 issue。

## 接口与架构

### 版本同步（单一来源）

- 版本单一来源定为 `apps/desktop/src-tauri/tauri.conf.json` 的 `version`（它同时驱动 `package.json` 的 app 版本与 Rust crate 版本）。
- 新增脚本 `scripts/sync-version.sh <x.y.z>`：改 `tauri.conf.json` → 同步 `package.json`、`apps/desktop/package.json`、`packages/engine/package.json`、`apps/desktop/src-tauri/Cargo.toml`。
- 新增漂移测试（复用 `crossLayerConstants.test.ts` 的解析手法）：断言四处的 `version` 与 `tauri.conf.json` 一致，防止再次失配。

### CI 流水线（GitHub Actions）

- **trigger**：push 与 PR。**jobs**：
  1. `engine`：`pnpm test`。
  2. `desktop`：`pnpm --filter @omd/desktop test` + `pnpm --filter @omd/desktop build`。
  3. `rust`：`cargo fmt --check` + `cargo test`（`apps/desktop/src-tauri`）。
  4. `link`：`scripts/build.sh`（复刻 `tauri dev` 的二进制链接，捕获链接期失败）。
- **release job**（仅 `v*` tag 触发）：`tauri build` → 签名 + 公证 → 上传产物 + 更新清单到 GitHub Release。
- 复用现有脚本，不在 CI 里另写一套构建命令（`scripts/build.sh` / `scripts/test.sh` 是唯一构建事实）。

### 签名与公证

- 证书与密钥走 GitHub Actions secrets（`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`），不进仓库。
- 公证用 `notarytool submit --wait`；`tauri.conf.json` 增 `bundle.macOS.signingIdentity`、`bundle.macOS.notarize` 相关配置（或由 CI 环境变量注入）。
- 本地无证书时不签名，仅 CI release 签名（开发环境 `tauri build` 仍可用，产物本地自用）。

### 自动更新

- 引入 `tauri-plugin-updater`（依赖在 `Cargo.toml` + 前端 invoke 封装）。
- 更新源 = GitHub Releases 的静态 JSON 清单（`latest.json` + 各平台签名文件），由 release job 生成。
- 前端仅做「检查 → 提示 → 触发下载」，不自行决定静默升级；升级由插件完成，成功后提示重启。

### 结构化日志与诊断包

- 引入 `tauri-plugin-log`，Rust 侧 `log::info/warn/error` 落到滚动文件（保留最近 N 个，单文件有界）。
- 前端 `window.alert` / `reportError` 保持现状；新增错误路径同时写日志。
- 新增窄命令 `export_diagnostics()`：收集日志文件 + `tauri.conf.json` 版本 + macOS 版本 + 崩溃报告目录，打包成 zip 写回用户选定路径。**脱敏**：日志不落文档正文、路径仅保留文件名、不含剪贴板与密钥。

## 约束

- **安全**：签名证书、公证凭据、Apple ID 密码只存在于 CI secrets；仓库与日志不出现任何密钥。诊断包不得包含文档内容与用户数据。
- **性能**：更新检查后台执行、有超时；日志写入不进入编辑主线程热路径（异步 + 有界缓冲）。
- **无障碍**：诊断包导出菜单项键盘可达（进命令面板 + View/Help 菜单）；更新提示为非模态、可键盘关闭。
- **迁移**：现有 `.githooks` 保持；CI 与其互补不重复。无 schema 迁移（不新增持久化数据结构）。

## 测试矩阵

| 层 | 测什么 | 工具 |
|---|---|---|
| 漂移 | 四处 `version` 与 `tauri.conf.json` 一致 | Vitest（仿 `crossLayerConstants.test.ts` 解析手法） |
| Rust | `export_diagnostics` 收集到日志/崩溃文件、路径脱敏、无日志时不 panic | cargo test |
| 前端 | 更新检查的 invoke 封装、非模态提示的状态切换 | Vitest（mock services） |
| CI | 四个 job 通过 + `v*` tag 触发 release job | GitHub Actions 自身 |
| 烟测 | 干净环境下载→安装→打开→建/存 .md | 人工清单（或脚本） |

## 手动 QA

- [ ] 发布 `.dmg` 在未开发过本项目的干净 Mac 上双击打开，Gatekeeper 无拦截。
- [ ] `pnpm release:version 0.2.0` 后 `rg '"0\.1\.0"'` 无残留；漂移测试通过。
- [ ] 打 tag 后 CI release job 产出 `.app` / `.dmg` / 更新清单并挂到 Release。
- [ ] 旧版本运行中检查到新版本并提示；确认后成功升级。
- [ ] 菜单「Export Diagnostics…」导出 zip，内容含日志与版本、无文档正文。
- [ ] 无网络时更新检查静默失败，不打断编辑。

## 文档

- 根 `README.md`：项目简介、安装、开发命令、发布流程（新建）。
- `CHANGELOG.md`：版本历史（新建，由发版命令生成草稿）。
- 根 `AGENTS.md`：Workspace Map 增 CI 与发布脚本；「Commands and Verification」补 `pnpm release:version` 与 CI 说明。
- `docs/manual-qa.md`：增「发布与升级」节（上方清单）。
- `docs/AGENTS.md`：生命周期补「CHANGELOG/README 更新时机」。

## 对后续规格提供的稳定接口

- **14 AI and Plugin Boundaries**：依赖本规格的更新通道——AI/插件能力随应用版本分发；插件 capability 模型需要「版本化发布 + 签名校验」打底。
- 诊断包命令 `export_diagnostics` 作为后续 bug 定位的通用入口，所有规格共享。
