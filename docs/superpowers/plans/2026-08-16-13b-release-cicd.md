# 13-B Release CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI 阻断、macOS 签名公证、`v*` tag 触发 release、静态更新清单、发布文档与烟测清单。

**Architecture:** 全部为配置/基础设施，交付物靠 review + 真实 GitHub/Apple 环境验证。CI 只 build 一次，release job 复用产物做签名公证与更新清单。签名与公证依赖 Apple Developer 账号（用户 2026-08-17 申请）。

**Tech Stack:** GitHub Actions、tauri build、`notarytool`、`stapler`、tauri-plugin-updater（依赖 13-A A6）。

**Spec:** `docs/superpowers/specs/2026-08-16-13-release-engineering-design.md`

> **状态（2026-08-18）：** Task B1 已完成（`.github/workflows/ci.yml` 四 job）。B2/B3 **阻塞于 Apple Developer 账号**（2026-08-17 提交申请，审批中），暂缓执行；B4 文档项随发布解锁一并收尾。`TAURI_SIGNING_PRIVATE_KEY` 已于 2026-08-18 配入 GitHub secrets；带口令密钥的取舍留待首次公开发版前决定。B1 的 push 确认跑见 `2026-08-18-13b-release-unblock.md` Task 4。

## TODO：Apple 账号解锁清单（B2/B3 启动条件）

- [ ] Apple Developer 账号审批通过（申请于 2026-08-17）。
- [ ] 生成 "Developer ID Application" 证书并导出 p12。
- [ ] GitHub 仓库 Settings → Secrets 配置 5 个签名公证 secret：`APPLE_CERTIFICATE`（base64 p12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`（app-specific）、`APPLE_TEAM_ID`。
- [x] 生成 updater 密钥对（2026-08-18）：公钥已写入 `tauri.conf.json`；私钥离线保管于本机 `~/.tauri/oh-my-md-updater.key`（空口令），**绝不入库**。首次公开发布前评估是否换用带口令密钥。
- [x] 将 `TAURI_SIGNING_PRIVATE_KEY`（私钥文件内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（空口令可省）加入 GitHub secrets。
- [ ] 执行 Task B2（签名 + 公证）与 Task B3（release job + `latest.json` 更新清单）。
- [ ] 真实验证：`v*` tag → Release 出现 `.app`/`.dmg`/`latest.json`，`spctl -a -vv` 无 Gatekeeper 拦截。

## Global Constraints

- 最低 macOS 12（CI runner 用 `macos-12`）。
- 密钥只进 GitHub Actions secrets：`APPLE_CERTIFICATE`（base64 p12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`（app-specific password）、`APPLE_TEAM_ID`。
- Build-once / sign-once：CI 只编译一次，release job 复用 artifact，不重编译。
- `v*` tag 触发 release；版本号与 tag 一致（`v0.2.0` ↔ `0.2.0`）。
- 更新清单 = GitHub Releases 静态 `latest.json` + 平台签名文件（tauri updater 官方格式）。
- 公证流程：`notarytool submit --wait` 成功后 `stapler staple` 到 `.app`/`.dmg`。
- 不上 App Store、无 E2E、无 Windows/Linux、无遥测。
- 验证：`pnpm verify` + 真实 push 到分支观察 Actions + 人工烟测清单。

---

### Task B1: 基础 CI（PR 阻断，无需 Apple 账号）

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** 四个 job：`engine`（`pnpm test`）、`desktop`（`pnpm --filter @omd/desktop test` + `build`）、`rust`（`cargo fmt --check` + `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`）、`link`（`bash scripts/build.sh`）。复用现有脚本，不在 CI 另写构建命令。

- [ ] **Step 1: 写 `.github/workflows/ci.yml`**——`on: push, pull_request`；`jobs` 四段如上；`actions/checkout@v4` + `pnpm/action-setup@v4` + `dtolnay/rust-toolchain@stable`。
- [ ] **Step 2: review** 检查 job 命名、runner（engine/desktop/rust/link 用 `macos-12` 或 `ubuntu-latest`，其中 `link` 需 macOS）。
- [ ] **Step 3: 真实验证** push 一个分支，观察 Actions 四 job 全绿（这是本 task 的唯一可执行验证）。
- [ ] **Step 4: Commit** `ci: add engine/desktop/rust/link workflow`

---

### Task B2: 签名 + 公证配置（门控：Apple 账号）

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`（`bundle.macOS` 增 signing/notarization 相关字段，值从 CI env 注入）
- Create: `.github/workflows/release.yml` 的签名步骤段（可与 B3 同文件，本 task 只写签名块）

**Interfaces:** 签名在 CI 内用 secrets 注入：导入 `APPLE_CERTIFICATE` 到临时 keychain，`tauri build` 用 `APPLE_SIGNING_IDENTITY`；公证用 `notarytool submit` + `stapler staple`。

- [ ] **Step 1: 在 GitHub 仓库 Settings → Secrets 配置 5 个 secret（见 Global Constraints）**——需要 Apple 账号已就绪。
- [ ] **Step 2: 写签名公证脚本段**——导入 p12 → `security set-key-partition-list` → `tauri build` → `notarytool submit --wait` → `stapler staple`。
- [ ] **Step 3: 真实验证** 打一个临时 tag 跑 release job，确认产物公证通过（`spctl -a -vv` 无 Gatekeeper 拦截）。
- [ ] **Step 4: Commit** `ci: sign and notarize macOS artifacts`

---

### Task B3: release job + 更新清单（门控：B2）

**Files:**
- Create/Modify: `.github/workflows/release.yml`
- Create: `scripts/gen-update-manifest.sh`

**Interfaces:**
- `scripts/gen-update-manifest.sh`：读取 `tauri.conf.json` 版本，生成 `latest.json`（含平台 target、版本、下载 URL、签名），供 `tauri-plugin-updater` 检查。
- release job：`on: push: tags: ['v*']` → `tauri build`（签名+公证）→ 生成更新清单 → `softprops/action-gh-release` 上传产物与清单。

- [ ] **Step 1: 写 `scripts/gen-update-manifest.sh`**——输出 `latest.json` 结构与签名字段。
- [ ] **Step 2: 写 `.github/workflows/release.yml`**——tag 触发、复用 B1/B2 的 build+sign 步骤、上传到 GitHub Release。
- [ ] **Step 3: 真实验证** 打 `v0.1.0` tag，确认 Release 出现 `.app`/`.dmg`/`latest.json`。
- [ ] **Step 4: Commit** `ci: release workflow with update manifest`

---

### Task B4: 文档收尾 + 烟测清单

**Files:**
- Modify: `README.md`（补发布流程：`pnpm release:version <x.y.z>` → 打 tag → CI 自动发布）
- Modify: `docs/manual-qa.md`（增「发布与升级」节，含 13-A/13-B 的烟测项）
- Modify: `AGENTS.md`（「Commands and Verification」补 `release:version` / `release:changelog`；Workspace Map 增 `.github/` 与发布脚本）
- Modify: `docs/AGENTS.md`（生命周期补 CHANGELOG/README 更新时机，若 13-A 未写）

**Interfaces:** 无。

- [ ] **Step 1: 补 README 发布流程**——写清版本号单一来源、tag 触发、secrets 依赖。
- [ ] **Step 2: 补 manual-qa 烟测清单**——Gatekeeper 放行、真实升级、公证产物 `spctl`、诊断包导出、干净环境安装烟测。
- [ ] **Step 3: 补 AGENTS.md 与 docs/AGENTS.md**——命令与路由。
- [ ] **Step 4: Commit** `docs: document release workflow and smoke checklist`

---

## 烟测清单（人工，需真实环境）

- [ ] 干净 Mac 双击 `.dmg` 打开，Gatekeeper 无拦截。
- [ ] `pnpm release:version 0.2.0` 后 `rg '"0\.1\.0"'` 无残留。
- [ ] `v*` tag 后 Release 出现 `.app`/`.dmg`/`latest.json`。
- [ ] 旧版本运行中检查到新版本并提示；确认后成功升级。
- [ ] 菜单「Export Diagnostics…」导出 zip，含日志与版本、无文档正文。
- [ ] 无网络时更新检查静默失败，不打断编辑。
