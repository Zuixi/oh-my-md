# 13-B 发布解堵（非 Apple 项）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 13-B 中不依赖 Apple Developer 账号的全部收尾：Export Diagnostics 的 UI 接线、B4 发布文档、13b 计划状态同步与版本残留冒烟、B1 CI 确认跑。

**Architecture:** 唯一的代码任务是补上 `export_diagnostics` 的前端入口（Rust 命令与测试已存在，但没有任何 UI 调用方）；其余为文档与状态同步。所有菜单/命令改动走既有 MENU_TO_COMMAND + crossLayerMenu 漂移防护体系。

**Tech Stack:** Tauri 2 menu.rs、React 命令面板、Vitest harness、cargo test。

**Spec:** `docs/superpowers/specs/2026-08-16-13-release-engineering-design.md`；状态载体 `docs/superpowers/plans/2026-08-16-13b-release-cicd.md`（Task B4 + 烟测清单）。

## Global Constraints

- 用户已于 2026-08-18 将 `TAURI_SIGNING_PRIVATE_KEY` 上传 GitHub secrets（本轮不再处理；带口令密钥的取舍仍是首次公开发版前的开放决策，只更新计划状态不执行换钥）。
- 菜单项 id 必须同时出现在 `menu.rs` 的 `.item(...)` 与 `commands.ts` 的 `MENU_TO_COMMAND`（`crossLayerMenu.test.ts` 自动守护；无快捷键的命令不得配 accelerator）。
- i18n en/zh 键必须成对出现。
- 提交遵循 `<type>: <why>`；不碰 `.vscode/settings.json` 与 `tauri.conf.json` 的既有未提交改动。
- B2/B3（签名公证、release job）保持 Apple 阻塞状态，本轮不动。

---

### Task 1: Export Diagnostics 命令接线（菜单 + 面板）

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs:84`（MenuLabels 增字段）、`:154`、`:221`（zh/en 标签）、`:407`（app_submenu 增菜单项）、`:661-670`（menu_strings 测试）
- Modify: `apps/desktop/src/commands.ts:37`（MENU_TO_COMMAND）
- Modify: `apps/desktop/src/App.tsx`（commands 数组，check-updates 条目旁）
- Modify: `apps/desktop/src/i18n/messages/en.ts`、`zh.ts`（`cmd.label.export-diagnostics`）
- Test: `apps/desktop/test/App.diagnostics.test.tsx`（新建）

**Interfaces:**
- Consumes: `services.exportDiagnostics?: () => Promise<void>`（`desktopServices.ts:134` 已存在，`tauri.conf.json` capability 已含所需权限；Rust 侧 `diagnostics.rs` 已有命令与测试）。
- Produces: 命令 id `"export-diagnostics"`（palette 与 native menu 同 id，经 MENU_TO_COMMAND 映射到自身）。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/App.diagnostics.test.tsx`（仿 `App.updateCheck.test.tsx` 的 mock/harness 结构）：

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
  }
})

const { editor } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

afterEach(() => resetMountedApps())

function openPaletteAndRun(query: string) {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: query } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

describe("export diagnostics wiring", () => {
  it("runs the diagnostics export service from the palette", async () => {
    const harness = createAppHarness(editor)
    const exportDiagnostics = vi.fn(async () => undefined)
    harness.services.exportDiagnostics = exportDiagnostics

    harness.renderApp()
    openPaletteAndRun("diagnostics")

    await waitFor(() => { expect(exportDiagnostics).toHaveBeenCalledTimes(1) })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/desktop exec vitest run test/App.diagnostics.test.tsx`
Expected: FAIL —— 面板过滤不到 "diagnostics" 命令（filterCommands 返回空，Enter 无 run 可执行，waitFor 超时）。

- [ ] **Step 3: 实现四侧接线**

`apps/desktop/src/commands.ts` —— `MENU_TO_COMMAND` 中 `"check-updates": "check-updates",` 之后加：

```ts
  "export-diagnostics": "export-diagnostics",
```

`apps/desktop/src/App.tsx` —— commands 数组中 check-updates 条目（约 `:1365`）后加：

```tsx
    { id: "export-diagnostics", label: t("cmd.label.export-diagnostics"), run: () => void services.exportDiagnostics?.() },
```

`apps/desktop/src/i18n/messages/en.ts` —— `cmd.label.check-updates` 键旁加：

```ts
  "cmd.label.export-diagnostics": "Export Diagnostics…",
```

`apps/desktop/src/i18n/messages/zh.ts` 对应处加：

```ts
  "cmd.label.export-diagnostics": "导出诊断信息…",
```

`apps/desktop/src-tauri/src/menu.rs`：

1. `MenuLabels` 结构体 `pub check_updates: &'static str,` 后加 `pub export_diagnostics: &'static str,`
2. zh 块 `check_updates: "检查更新…",` 后加 `export_diagnostics: "导出诊断信息…",`
3. en 块 `check_updates: "Check for Updates…",` 后加 `export_diagnostics: "Export Diagnostics…",`
4. `app_submenu` 中 `.item(&item(app, "check-updates", l.check_updates, None)?)` 后加：

```rust
        .item(&item(app, "export-diagnostics", l.export_diagnostics, None)?)
```

5. `menu_strings` 测试处（`:661`、`:670` 附近）各加一行断言：

```rust
        assert_eq!(l.export_diagnostics, "导出诊断信息…");
        assert_eq!(l.export_diagnostics, "Export Diagnostics…");
```

- [ ] **Step 4: 跑测试确认通过（含漂移防护）**

Run: `pnpm --filter @omd/desktop exec vitest run test/App.diagnostics.test.tsx test/crossLayerMenu.test.ts && cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml diagnostics`
Expected: 全部 PASS/OK（crossLayerMenu 自动校验新菜单项映射与无 accelerator 约束）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/menu.rs apps/desktop/src/commands.ts apps/desktop/src/App.tsx apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh.ts apps/desktop/test/App.diagnostics.test.tsx
git commit -m "feat: surface export diagnostics in menu and palette"
```

---

### Task 2: B4 发布文档收尾

**Files:**
- Modify: `README.md:39-54`（发布节更新）
- Modify: `AGENTS.md`（Commands and Verification 增 release 命令；Workspace Map 增 `.github/`）
- Modify: `docs/AGENTS.md`（Document Lifecycle 增 CHANGELOG/README 更新时机一条）
- Modify: `docs/manual-qa.md`（新增「发布与升级」节）

**Interfaces:** 无代码接口；所有命令名引用既有脚本（`pnpm release:version` / `pnpm release:changelog`，均已在 root package.json）。

- [ ] **Step 1: README 发布节更新** —— 将「正式发布流水线…」段替换为（保留前后原文不动）：

```markdown
**CI：** 每次 push / PR 跑四个 job（engine / desktop / rust / link，见 `.github/workflows/ci.yml`）。发布产物流水线（签名公证 + GitHub Release + `latest.json`）阻塞于 Apple Developer 账号审批，解锁清单见 [13-B 计划](./docs/superpowers/plans/2026-08-16-13b-release-cicd.md)。updater 签名私钥已配入 GitHub secrets（`TAURI_SIGNING_PRIVATE_KEY`）；`tauri.conf.json` 已含 updater 公钥与 `createUpdaterArtifacts`，release CI 产出 `latest.json` 后应用内「检查更新…」即可端到端生效。
```

- [ ] **Step 2: AGENTS.md 更新**

Commands 代码块中 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 后加两行：

```sh
pnpm release:version <x.y.z>
pnpm release:changelog
```

代码块下方 bullet 列表末尾加：

```markdown
- `release:version` 同步四处版本号（tauri.conf.json 为单一来源），`release:changelog` 用 git-cliff 从 conventional commits 生成 CHANGELOG。两者只在发版时使用；`release:changelog` 依赖本机 `git-cliff`。
```

Workspace Map 的 text 树中 `└── docs/` 之前插入：

```text
├── .github/workflows/    # CI：engine/desktop/rust/link 四 job（发布流水线阻塞于 Apple 账号）
```

（相应把 `└── docs/` 上方原来的 `└──`/`├──` 层级对齐。）

- [ ] **Step 3: docs/AGENTS.md** —— Document Lifecycle 列表末尾加：

```markdown
- **CHANGELOG and README update at release time.** Run `pnpm release:changelog`
  (conventional commits are the input — the commit-msg hook enforces the type
  prefix) when cutting a version, and touch README whenever user-visible
  setup, shortcuts, or release flow change. Specs and plans record decisions;
  README and CHANGELOG are the only user-facing docs.
```

- [ ] **Step 4: manual-qa 增「发布与升级」节** —— 文末追加：

```markdown
## 发布与升级（13-A/13-B 烟测）

> 需要 `tauri build` 产物或真实 Release 的项目标注了前提；Apple 公证链路（B2/B3）解锁后补充。

- [ ] `pnpm release:version 0.2.0` 后四处版本号更新，`rg '"0\.1\.0"' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json` 无残留，`rg '^version = "0\.1\.0"' apps/desktop/src-tauri/Cargo.toml` 无残留（验证后还原改动）。
- [ ] 菜单「导出诊断信息…」：保存 zip；zip 含版本与日志文件、不含任何文档正文。
- [ ] 断网状态下启动 App：8s 后无任何更新提示，编辑不受影响；「检查更新…」显示已是最新或静默，无未处理错误弹窗。
- [ ] （需打包产物）双击 `.md` / Finder 拖入 Dock 图标打开文件；再次启动聚焦既有窗口。
- [ ] （需 B3 Release）旧版本内「检查更新…」提示新版本 → 升级成功；`latest.json` 可访问。
- [ ] （需 B2 公证）干净 Mac 安装无 Gatekeeper 拦截，`spctl -a -vv` 通过。
```

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md docs/AGENTS.md docs/manual-qa.md
git commit -m "docs: release workflow docs and smoke checklist"
```

---

### Task 3: 13b 计划状态同步 + 版本残留冒烟

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-13b-release-cicd.md:21`（勾选 secrets 项）、状态注记（`:13`）

**Interfaces:** 无。

- [ ] **Step 1: 本地版本残留冒烟（临时改动，验证后还原）**

```bash
pnpm release:version 0.2.0
rg '"0\.1\.0"' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json || echo "no residue"
rg '^version = "0\.1\.0"' apps/desktop/src-tauri/Cargo.toml || echo "no residue"
git checkout -- package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
```

Expected: 两个 `rg` 均无匹配（输出 `no residue`）；还原后 `git status` 中这四个文件干净。

- [ ] **Step 2: 更新 13b 计划** —— 第 21 行 `- [ ] 将 \`TAURI_SIGNING_PRIVATE_KEY\`…` 改为 `- [x]`；状态注记（第 13 行段末）追加一句：

```markdown
`TAURI_SIGNING_PRIVATE_KEY` 已于 2026-08-18 配入 GitHub secrets；带口令密钥的取舍留待首次公开发版前决定。B1 的 push 确认跑见 `2026-08-18-13b-release-unblock.md` Task 4。
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-08-16-13b-release-cicd.md
git commit -m "docs: sync 13b status after updater secret upload"
```

---

### Task 4: B1 CI 确认跑（需要用户放行 push）

**Files:** 无仓库改动；纯环境验证。

**Interfaces:** `.github/workflows/ci.yml` 四 job（engine/desktop/rust/link）。

- [ ] **Step 1: 征得用户同意后推送空提交分支**

```bash
git switch -c ci/confirm-b1
git commit --allow-empty -m "ci: confirm workflow runs on all four jobs"
git push -u origin ci/confirm-b1
```

- [ ] **Step 2: 观察四 job 全绿**

```bash
gh run watch --exit-status $(gh run list --branch ci/confirm-b1 --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: engine / desktop / rust / link 四 job 全部 success。

- [ ] **Step 3: 清理** —— `git switch main && git branch -D ci/confirm-b1`（远端分支可留可删，默认保留供回看）。在 13b 计划 B1 的 Step 3 checkbox 打勾并提交 `docs: record ci confirming run`。
